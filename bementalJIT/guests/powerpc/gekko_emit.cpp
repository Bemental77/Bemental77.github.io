// gekko_emit.cpp — Gekko (PowerPC 750CL) → WASM emitter implementation.
//
// Mirrors Dolphin's Interpreter_Tables.cpp dispatch shape:
//   primary[64]  → either a direct emitter, or a sub-table sentinel that
//   forces a second lookup into table4 / table19 / table31 / table59 / 63.
//
// Native emitters cover the integer / load-store / branch / compare / logical /
// shift hot paths. Anything not implemented here (FP, paired singles, exotic
// system ops) emits a wasm_interp_fallback call which re-uses Dolphin's
// existing Interpreter::RunInterpreterOp.

#include "gekko_emit.h"
#include "bementalJIT/perf_runtime.h"
#include <array>
#include <cstdio>
#include <cstring>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace bemental::powerpc {

// ===========================================================================
// Native emitters — integer arithmetic / D-form
// ===========================================================================

// addi rt, ra, simm     (RA==0 ⇒ literal 0)
//   rt = (RA==0 ? 0 : ra) + simm
static void emit_addi(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    emit_pre_store_gpr(c, /*ctx_ptr (patched in by build_block)*/ 0);
    // We need to know ctx_ptr at emit time — but the EmitCtx doesn't carry it.
    // build_block injects ctx_ptr by closing over the lambda; for header
    // helpers we use a side-channel: a thread-local set by build_block.
    // (See g_ctx_ptr at the bottom of this file.)
    (void)ra; (void)simm; (void)rt;
}

// We avoid the thread-local hack by giving every emit fn the full context
// through a shared "EmitState" stored on EmitCtx. Simpler: pass ctx_ptr via a
// global set per build_block call (these are not reentrant, but that matches
// the rest of bementalJIT).
u32 g_ctx_ptr = 0;
// Debug toggle: when true, emit_body_into sets ctx.use_gpr_locals = false,
// reverting to legacy memory-direct GPR access. Used in tests to isolate
// JIT bugs from B11 cache logic.
bool g_disable_b11 = false;
// Linear-memory offset of MEM1 in the shared host heap, set per-build by
// build_block(). Zero means "fast-path direct memory access disabled, fall
// back to ppc_read*/ppc_write* trampolines for everything." When non-zero,
// D-form load/store emitters take a runtime branch on the address: cached-
// MEM1 hits go via i32.load/store offset=g_mem1_base, everything else
// (MMIO, MEM2 etc.) falls through to the trampoline.
static u32 g_mem1_base = 0;
static u32 g_mem1_mask = 0;
static u32 g_ram_size  = 0;
// True when the per-block trust DFA proved every D-form load/store base
// register is r1/r2/r13-derived. When true, emit_load_d/emit_store_d
// skip the runtime range check and emit the direct linear-memory access
// directly. When false but mem1_base != 0, they emit the runtime range
// check + fastmem-on-hit pattern (analogous to emit_load_x). Pre-
// no-liftoff this was Liftoff-perf-cliff-bound; with TurboFan-only the
// if-result-i32 cliff is gone.
static bool g_mem1_safe = false;

// ---------------------------------------------------------------------------
// B11 GPR-local cache helper bodies. Forward-declared in gekko_emit.h.
//
// emit_gpr_get_impl: pushes gpr[i] onto the WASM stack. Lazy: if not yet
//   loaded, emit `i32.const ctx; i32.load gpr_off; local.tee idx`. If
//   loaded, emit `local.get idx`.
// emit_gpr_set_impl: pops top, writes to local idx (if cache enabled) or
//   directly to memory at gpr_off (legacy). Caller must NOT pre-push ctx
//   in either mode.
// emit_flush_dirty_gprs_impl: writes back every gpr_dirty[i]==true to
//   memory and clears the dirty bit. Loaded state remains true (cached
//   value is now also in memory).
// emit_invalidate_gpr_locals: clears loaded[] and dirty[]; caller is
//   responsible for ensuring memory has the canonical state. Used after
//   fallback (interpreter may have mutated ppc_state.gpr).
// ---------------------------------------------------------------------------
void emit_gpr_get_impl(EmitCtx& c, u32 i, u32 ctx_ptr) {
    // Inside an if/else block (if_depth > 0), runtime may not take the
    // path that initialises the local — fall back to direct memory.
    // See EmitCtx::if_depth comment in gekko_emit.h.
    if (!c.use_gpr_locals || c.if_depth > 0) {
        c.b.op_i32_const((s32)ctx_ptr);
        c.b.op_i32_load(ppc_off::gpr(i));
        return;
    }
    if (!c.gpr_loaded[i]) {
        c.b.op_i32_const((s32)ctx_ptr);
        c.b.op_i32_load(ppc_off::gpr(i));
        c.b.op_local_tee(gpr_local_idx(i));   // keep on stack + write local
        c.gpr_loaded[i] = true;
    } else {
        c.b.op_local_get(gpr_local_idx(i));
    }
}

void emit_gpr_set_impl(EmitCtx& c, u32 i, u32 ctx_ptr, u32 scratch) {
    if (!c.use_gpr_locals || c.if_depth > 0) {
        // Legacy memory path: incoming stack is [value]; we need [ctx, value]
        // before i32.store. Use the caller-provided `scratch` local for the
        // swap. Caller is responsible for choosing a local it does NOT need
        // to preserve across this call (typically LOCAL_TMP_B if the caller
        // is using LOCAL_TMP_A, or vice versa). See
        // jit_scratch_clobber_pattern_2026_05_05.md for why this is a param.
        c.b.op_local_set(scratch);
        c.b.op_i32_const((s32)ctx_ptr);
        c.b.op_local_get(scratch);
        c.b.op_i32_store(ppc_off::gpr(i));
        return;
    }
    (void)scratch;
    c.b.op_local_set(gpr_local_idx(i));
    c.gpr_loaded[i] = true;
    c.gpr_dirty[i]  = true;
}

// Phase 3 prereq — wrappers around c.b.op_if/op_else/op_end. Manage
// EmitCtx::if_depth so emit_gpr_get_impl/emit_gpr_set_impl fall back to
// direct memory inside the if/else, and invalidate the cache after the
// merge point so post-if code can't rely on partially-loaded state.
//
// Mirrors V8 Liftoff's "spill before branch + invalidate after merge"
// pattern (see jit_b11_phase1_2026_05_05.md research synthesis), with
// the simplification that we use one universal flush+invalidate instead
// of per-branch CacheState snapshot/merge.
void emit_b11_op_if(EmitCtx& c, u8 result_type) {
    if (c.use_gpr_locals && c.if_depth == 0u) {
        // Flush dirty so memory is current before the legacy-path emits
        // inside the if/else read fresh values.
        emit_flush_dirty_gprs_impl(c, g_ctx_ptr);
    }
    c.if_depth++;
    c.local_block_depth++;
    c.b.op_if(result_type);
}

void emit_b11_op_else(EmitCtx& c) {
    // op_else doesn't change block-stack depth — it's the alternative
    // arm of the same if's block.
    c.b.op_else();
}

void emit_b11_op_end(EmitCtx& c) {
    c.b.op_end();
    if (c.if_depth > 0u) c.if_depth--;
    if (c.local_block_depth > 0u) c.local_block_depth--;
    if (c.use_gpr_locals && c.if_depth == 0u) {
        // Conservative: invalidate all loaded[] flags. Runtime took ONE
        // arm; we don't know which gprs that arm loaded. Locals may be
        // stale relative to memory (which is current — every if/else
        // arm uses the legacy memory path).
        emit_invalidate_gpr_locals(c);
    }
}

// Wrappers for raw op_block/op_loop/op_if/op_end sites that don't go
// through emit_b11_op_*. Track local_block_depth so the merged-mode
// br-to-loop branch can compute correct depths.
static inline void emit_local_op_block(EmitCtx& c, u8 result_type = 0x40) {
    c.b.op_block(result_type);
    c.local_block_depth++;
}
static inline void emit_local_op_loop(EmitCtx& c, u8 result_type = 0x40) {
    c.b.op_loop(result_type);
    c.local_block_depth++;
}
static inline void emit_local_op_if(EmitCtx& c, u8 result_type = 0x40) {
    c.b.op_if(result_type);
    c.local_block_depth++;
}
static inline void emit_local_op_end(EmitCtx& c) {
    c.b.op_end();
    if (c.local_block_depth > 0u) c.local_block_depth--;
}

void emit_flush_dirty_gprs_impl(EmitCtx& c, u32 ctx_ptr) {
    if (!c.use_gpr_locals) return;
    for (u32 i = 0; i < 32u; ++i) {
        if (!c.gpr_dirty[i]) continue;
        c.b.op_i32_const((s32)ctx_ptr);
        c.b.op_local_get(gpr_local_idx(i));
        c.b.op_i32_store(ppc_off::gpr(i));
        c.gpr_dirty[i] = false;
        // Loaded stays true: memory and local now agree.
    }
}

// Flush dirty GPRs WITHOUT updating the compile-time dirty[]/loaded[]
// state. Used inside conditional-return branches (e.g. exception bail) so
// the post-branch code (which executes when the branch isn't taken at
// runtime) still treats GPR locals as if the flush hadn't happened.
void emit_flush_dirty_gprs_inside_branch(EmitCtx& c, u32 ctx_ptr) {
    if (!c.use_gpr_locals) return;
    for (u32 i = 0; i < 32u; ++i) {
        if (!c.gpr_dirty[i]) continue;
        c.b.op_i32_const((s32)ctx_ptr);
        c.b.op_local_get(gpr_local_idx(i));
        c.b.op_i32_store(ppc_off::gpr(i));
        // Intentionally leave c.gpr_dirty[i] alone.
    }
}

void emit_invalidate_gpr_locals(EmitCtx& c) {
    if (!c.use_gpr_locals) return;
    for (u32 i = 0; i < 32u; ++i) {
        c.gpr_loaded[i] = false;
        c.gpr_dirty[i]  = false;
    }
}


#define CTX (g_ctx_ptr)

// Re-implement addi cleanly now that CTX is defined.
// B11 Phase 2 Task 1 — migrated to emit_gpr_get_impl / emit_gpr_set_impl.
// Cat A: load + compute + store, no TMP_A reuse.
static void emit_addi_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    if (ra == 0) {
        c.b.op_i32_const(simm);
    } else {
        emit_gpr_get_impl(c, ra, g_ctx_ptr);
        c.b.op_i32_const(simm);
        c.b.op_i32_add();
    }
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
}

// addis rt, ra, simm   ; rt = (RA==0 ? 0 : ra) + (simm << 16)
// B11 Phase 2 Task 2 — cat A.
static void emit_addis_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = (s32)((u32)(s32)(s16)c.inst << 16);
    if (ra == 0) {
        c.b.op_i32_const(simm);
    } else {
        emit_gpr_get_impl(c, ra, g_ctx_ptr);
        c.b.op_i32_const(simm);
        c.b.op_i32_add();
    }
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
}

// addic rt, ra, simm   ; rt = ra + simm; XER.CA = unsigned-carry
//   We compute rt and (sum < ra) for carry.
//
// B11 Phase 2 Task 5 — cat C (TMP_A reuse).
// Invariant: after emit_gpr_set_impl(rt) in legacy mode, TMP_A is
// rewritten to the same `sum` value that was in it before (the helper
// pops the value and writes it back into TMP_A as part of its swap).
// So TMP_A still holds sum for the CA compute below. In B11 mode,
// emit_gpr_set_impl writes a different local (gpr_local[rt]) and leaves
// TMP_A alone — same end state.
//
// Pre-existing semantic note (NOT introduced by this migration): when
// rt == ra, the rt store overwrites memory, and the subsequent CA
// compute reads the just-written memory. The CA bit is computed against
// `sum` instead of original `ra` — wrong by spec (CA must use OLD rA).
// The original emit had this bug; we preserve behavior. Real games rarely
// alias rt==ra in addic.
static void emit_addic_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    // sum = ra + simm; tee into TMP_A so the CA compute below has it
    // even after the rt store potentially clobbers TMP_A in legacy mode.
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_const(simm);
    c.b.op_i32_add();
    c.b.op_local_tee(LOCAL_TMP_A);
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);  // legacy clobbers TMP_A := sum (idempotent)
    // CA = (sum < ra) unsigned. Pre-push CTX for the i32.store8 below.
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_lt_u();
    c.b.op_i32_store8(ppc_off::XER_CA);
}

// addic. — addic with Rc=1 (set CR0 from result)
// B11 Phase 2 Task 5 — cat C. After emit_addic_impl, TMP_A holds sum
// (in both modes), so we just reuse it directly instead of re-reading
// gpr[rt] from memory.
static void emit_addic_rc_impl(EmitCtx& c) {
    emit_addic_impl(c);
    c.b.op_local_get(LOCAL_TMP_A);
    emit_set_cr0(c, CTX, LOCAL_TMP_A);
}

// subfic rt, ra, simm  ; rt = simm - ra; CA = unsigned ~ra + simm + 1 carry
// B11 Phase 2 Task 4 — cat A. The CA store at XER_CA is non-GPR memory
// so it keeps the legacy `[ctx, val] → i32.store8` shape with explicit
// pre-pushed CTX.
static void emit_subfic_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    c.b.op_i32_const(simm);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_sub();
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    // CA: simm >= ra (unsigned). Pre-push CTX for the i32.store8 below.
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_const(simm);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_ge_u();
    c.b.op_i32_store8(ppc_off::XER_CA);
}

// mulli rt, ra, simm   ; rt = ra * simm (signed, low 32 bits)
// B11 Phase 2 Task 3 — cat A.
static void emit_mulli_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_const(simm);
    c.b.op_i32_mul();
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
}

// cmpi crfd, L, ra, simm  ; signed compare ra <-> simm into CR field crfd
//   Use Dolphin's "sign-extend the result" CR encoding (see emit_set_cr0
//   comment): write (ra - simm) as low 32 and its sign extension as high 32.
//   Signed compare result is correctly captured because the sign of (ra-simm)
//   matches the GT/LT/EQ relation.
// B11 Phase 2 Task 15 — cat A.
static void emit_cmpi_impl(EmitCtx& c) {
    const u32 crfd = CRFD(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    // result = ra - simm  (kept in TMP_A)
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_const(simm);
    c.b.op_i32_sub();
    c.b.op_local_set(LOCAL_TMP_A);
    // Store low 32
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_store(ppc_off::cr_field(crfd));
    // Store high 32 = (result >> 31 signed)
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(31);
    c.b.op_i32_shr_s();
    c.b.op_i32_store(ppc_off::cr_field(crfd) + 4);
}

// cmpli crfd, L, ra, uimm ; unsigned compare
//   Dolphin's CR encoding for unsigned compare needs explicit construction:
//     EQ: low=0, high=0           (cr_val == 0 ⇒ EQ via low-32==0 check)
//     LT: low=1, high=0xC0000000  (bit 62 set ⇒ LT, bit 63 set ⇒ negative
//                                   so (s64)>0 fails ⇒ GT=0)
//     GT: low=1, high=0           (positive non-zero ⇒ GT, low!=0 ⇒ EQ=0)
// B11 Phase 2 Task 17 — cat A.
static void emit_cmpli_impl(EmitCtx& c) {
    const u32 crfd = CRFD(c.inst), ra = RA(c.inst);
    const u32 uimm = UIMM_16(c.inst);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_A);
    // low_word = (ra != uimm) ? 1 : 0
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const((s32)uimm);
    c.b.op_i32_ne();
    c.b.op_local_set(LOCAL_TMP_B);
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_store(ppc_off::cr_field(crfd));
    // high_word = (ra < uimm unsigned) ? 0xC0000000 : 0
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const((s32)uimm);
    c.b.op_i32_lt_u();
    c.b.op_i32_const(30);
    c.b.op_i32_shl();             // bit 30 of high → bit 62 of u64
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const((s32)uimm);
    c.b.op_i32_lt_u();
    c.b.op_i32_const(31);
    c.b.op_i32_shl();             // bit 31 of high → bit 63 of u64
    c.b.op_i32_or();              // high = LT ? 0xC0000000 : 0
    c.b.op_local_set(LOCAL_TMP_B);
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_store(ppc_off::cr_field(crfd) + 4);
}

// ori rs, ra, uimm     ; ra = rs | uimm
// Note: PPC encoding has RS in the RT slot; "ra" here is the destination.
// B11 Phase 2 Task 6 — cat A. Covers ori/oris/xori/xoris.
static void emit_logical_imm(EmitCtx& c, u32 wasm_op_byte, bool high) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const u32 imm = UIMM_16(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_i32_const((s32)(high ? (imm << 16) : imm));
    c.b.emitByte(wasm_op_byte); // i32_or / i32_and / i32_xor
    emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
}

static void emit_ori_impl  (EmitCtx& c) { emit_logical_imm(c, wop::i32_or,  false); }
static void emit_oris_impl (EmitCtx& c) { emit_logical_imm(c, wop::i32_or,  true);  }
static void emit_xori_impl (EmitCtx& c) { emit_logical_imm(c, wop::i32_xor, false); }
static void emit_xoris_impl(EmitCtx& c) { emit_logical_imm(c, wop::i32_xor, true);  }

// andi. / andis. — same as ori/oris but AND, and CR0 is set from result.
// B11 Phase 2 Tasks 7-8 — cat B (TMP_A holds result; emit_gpr_set_impl
// in legacy clobbers TMP_A := same result, idempotent).
static void emit_andi_rc_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const u32 imm = UIMM_16(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_i32_const((s32)imm);
    c.b.op_i32_and();
    c.b.op_local_tee(LOCAL_TMP_A);
    emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    // CR0 from result (TMP_A still holds it).
    c.b.op_local_get(LOCAL_TMP_A);
    emit_set_cr0(c, CTX, LOCAL_TMP_A);
}

static void emit_andis_rc_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const u32 imm = (u32)UIMM_16(c.inst) << 16;
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_i32_const((s32)imm);
    c.b.op_i32_and();
    c.b.op_local_tee(LOCAL_TMP_A);
    emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    c.b.op_local_get(LOCAL_TMP_A);
    emit_set_cr0(c, CTX, LOCAL_TMP_A);
}

// ===========================================================================
// Native emitters — D-form load/store (memory access via host imports)
// ===========================================================================

// Helper: compute effective address ra + simm (RA==0 ⇒ 0). Leaves EA on stack.
static void emit_ea_d(EmitCtx& c, u32 ra, s32 simm) {
    if (ra == 0) {
        c.b.op_i32_const(simm);
    } else {
        emit_gpr_get_impl(c, ra, g_ctx_ptr);
        c.b.op_i32_const(simm);
        c.b.op_i32_add();
    }
}

// Phase A1: SAB MMIO mirror constants. Mirrored from
// gamecube/ppc-worker/sab_layout.h. Both sides MUST agree.
//
// When EA is in [0xCC000000, 0xCC040000) AND the per-cell classification
// table marks it DIRECT_RW, the read can come from a SAB-resident mirror
// page that dolphin keeps current. Skips the synchronous mailbox round-
// trip that previously dominated per-instruction cost.
//
// Mirror values are stored host-native (semantic value, NOT BE-encoded
// like guest MEM1). NO byte-swap on read — dolphin writes via memcpy
// from its u16/u32 register-file fields, so the bytes already represent
// the value the guest expects from a PPC LWZ/LHZ.
constexpr u32 MMIO_GUEST_BASE       = 0xCC000000u;
constexpr u32 MMIO_GUEST_LIMIT      = 0xCC040000u;
constexpr u32 MMIO_GUEST_RANGE_BYTES = MMIO_GUEST_LIMIT - MMIO_GUEST_BASE;
constexpr u32 MMIO_MIRROR_ADDR      = 0x02600000u;
constexpr u32 MMIO_CLS16_ADDR       = 0x02640000u;
constexpr u32 MMIO_CLS32_ADDR       = 0x02660000u;
constexpr u8  MMIO_CLASS_DIRECT_RW  = 1u;

// Helper: emit the slow-path branch with an MMIO-mirror fast-path inserted
// in front. EA must be in LOCAL_TMP_A from the caller. Result of the
// expression (one i32 — the loaded value) is left on the stack.
//
// Layout:
//   rel = ea - 0xCC000000
//   if (rel < 0x40000) AND (cls[rel >> shift] == DIRECT_RW)
//       i32.load[16_u]  offset = MMIO_MIRROR_ADDR
//   else
//       call import_idx        ; ppc_read*(ea)
//
// 8-bit reads skip the mirror entirely (no cls8 table in stage 1) and
// fall straight to the import — matches today's behavior. Rare in MMIO.
static void emit_mmio_mirror_else_or_import(EmitCtx& c, u32 import_idx) {
    if (import_idx == WIMPORT_READ8) {
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_call(import_idx);
        return;
    }
    const u32 cls_addr  = (import_idx == WIMPORT_READ32) ? MMIO_CLS32_ADDR
                                                         : MMIO_CLS16_ADDR;
    const u32 cls_shift = (import_idx == WIMPORT_READ32) ? 2u : 1u;

    // rel = ea - MMIO_GUEST_BASE — kept ONLY in LOCAL_TMP_B (set, not
    // tee — leaving rel on the stack here would imbalance the if-block
    // below: each arm would fall through with [rel, value] but the
    // block result is one i32, tripping wasm validation
    // ("expected 1 elements on the stack for fallthru, found 2").
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const((s32)MMIO_GUEST_BASE);
    c.b.op_i32_sub();
    c.b.op_local_set(LOCAL_TMP_B);

    // cls[(rel & range_mask) >> shift] == DIRECT_RW
    // The mask is critical: rel can be > range_bytes when EA is in
    // MEM1 / cached / uncached space (e.g. 0x80003140). Without the
    // mask, rel >> shift would index past the cls table and trap
    // ("memory access out of bounds"). Masking keeps the cls read
    // safe; the in_range check below makes the result irrelevant.
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_const((s32)(MMIO_GUEST_RANGE_BYTES - 1u));
    c.b.op_i32_and();
    c.b.op_i32_const((s32)cls_shift);
    c.b.op_i32_shr_u();
    c.b.op_i32_load8_u(cls_addr);          // offset = cls table base
    c.b.op_i32_const((s32)MMIO_CLASS_DIRECT_RW);
    c.b.op_i32_eq();

    // rel < MMIO_GUEST_RANGE_BYTES — bounds-guards the cls read above.
    // (Out-of-range cls reads land harmlessly in adjacent SAB anyway,
    // but the AND below ensures we never act on a junk cls byte.)
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_const((s32)MMIO_GUEST_RANGE_BYTES);
    c.b.op_i32_lt_u();

    c.b.op_i32_and();
    emit_local_op_if(c, WASM_TYPE_I32);
        c.b.op_local_get(LOCAL_TMP_B);
        if (import_idx == WIMPORT_READ32) {
            c.b.op_i32_load(MMIO_MIRROR_ADDR);
        } else {
            c.b.op_i32_load16_u(MMIO_MIRROR_ADDR);
        }
    c.b.op_else();
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_call(import_idx);
    emit_local_op_end(c);
}

// lbz/lhz/lwz/lha — D-form loads. update flag toggles RA writeback (lbzu etc.)
//
// Fast-path: emit a runtime range check + direct WASM linear-memory load
// when the address falls in cached/uncached/real MEM1 mirrors. The shared
// linear memory IS the emscripten heap, so MEM1's storage at offset
// g_mem1_base is reachable from the JIT block via an `i32.load offset=N`.
// PPC memory is big-endian; emscripten/WASM is little-endian, so the
// loaded value needs a 32-bit byte swap (or 16-bit for halfword ops).
//
// Range detection: GameCube maps MEM1 at three logical bases:
//   0x80000000-0x817FFFFF  (cached)
//   0xC0000000-0xC17FFFFF  (uncached)
//   0x00000000-0x017FFFFF  (real-mode physical)
// Common test: `(addr & 0x01FFFFFF) < ram_size`. Fast and covers all three.
//
// We embed the load width in `import_idx` (WIMPORT_READ8/16/32). The fast
// path emits the matching native i32.load8_u / load16_u / load.
static void emit_load_d(EmitCtx& c, u32 import_idx, bool sign_extend_h, bool update) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    // EA in tmp_a (also drop one copy to keep stack clean for the branch).
    emit_ea_d(c, ra, simm);
    c.b.op_local_tee(LOCAL_TMP_A);
    c.b.op_drop();

    // Three-way fastmem dispatch:
    //   (a) g_mem1_base == 0          → caller provided no fastmem base; import
    //   (b) g_mem1_base != 0 && g_mem1_safe → trust DFA proved MEM1; direct load
    //   (c) g_mem1_base != 0 && !g_mem1_safe → runtime range check then direct
    //                                          or import (analogous to emit_load_x)
    //
    // Path (c) was previously path (a) — every D-form in an "untrusted" block
    // hit the JS import. With --no-liftoff the if-result-i32 cliff is gone,
    // so the runtime check is cheap. Untrusted-block r32 calls drop
    // dramatically when most of the addresses ARE in MEM1.
    auto emit_direct_load_post = [&]() {
        if (import_idx == WIMPORT_READ32) {
            c.b.op_i32_load(0);
            c.b.op_local_tee(LOCAL_TMP_B);
            c.b.op_i32_const(24);
            c.b.op_i32_shr_u();
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const(8);
            c.b.op_i32_shr_u();
            c.b.op_i32_const(0xFF00);
            c.b.op_i32_and();
            c.b.op_i32_or();
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const(8);
            c.b.op_i32_shl();
            c.b.op_i32_const(0xFF0000);
            c.b.op_i32_and();
            c.b.op_i32_or();
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const(24);
            c.b.op_i32_shl();
            c.b.op_i32_or();
        } else if (import_idx == WIMPORT_READ16) {
            c.b.op_i32_load16_u(0);
            c.b.op_local_tee(LOCAL_TMP_B);
            c.b.op_i32_const(8);
            c.b.op_i32_shr_u();
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const(8);
            c.b.op_i32_shl();
            c.b.op_i32_or();
            c.b.op_i32_const(0xFFFF);
            c.b.op_i32_and();
        } else {
            c.b.op_i32_load8_u(0);
        }
    };
    if (g_mem1_base == 0u) {
        // (a) No fastmem base provided; try MMIO mirror first, then import.
        emit_mmio_mirror_else_or_import(c, import_idx);
    } else if (g_mem1_safe) {
        // (b) Trust DFA passed; direct load with mask + add (no runtime branch).
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0x017FFFFF);
        c.b.op_i32_and();
        c.b.op_i32_const((s32)g_mem1_base);
        c.b.op_i32_add();
        emit_direct_load_post();
    } else {
        // (c) Untrusted block; runtime range check (matches emit_load_x).
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0x1F000000);
        c.b.op_i32_and();
        c.b.op_i32_eqz();                          // high mirror byte OK
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0x01FFFFFF);
        c.b.op_i32_and();
        c.b.op_local_tee(LOCAL_TMP_B);             // phys offset
        c.b.op_i32_const((s32)g_ram_size);
        c.b.op_i32_lt_u();
        c.b.op_i32_and();
        emit_local_op_if(c, WASM_TYPE_I32);
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const((s32)g_mem1_base);
            c.b.op_i32_add();
            emit_direct_load_post();
        c.b.op_else();
            // MEM1 missed; try MMIO mirror before falling to import.
            emit_mmio_mirror_else_or_import(c, import_idx);
        emit_local_op_end(c);
    }

    if (sign_extend_h) {
        // Sign-extend from 16-bit. WASM has no direct i32_extend16, but
        // (val << 16) >> 16 (signed) does it.
        c.b.op_i32_const(16);
        c.b.op_i32_shl();
        c.b.op_i32_const(16);
        c.b.op_i32_shr_s();
    }
    c.b.op_local_set(LOCAL_TMP_B);
    // Update RA first — emit_gpr_set_impl in legacy mode uses TMP_A as a
    // swap (`local.set TMP_A; ctx; local.get TMP_A; i32.store`) which
    // clobbers TMP_A. EA is currently in TMP_A from emit_ea_d, so the
    // update-ra store MUST happen before the rt store.
    if (update && ra != 0) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
    // Now TMP_A may be clobbered; safe.
    c.b.op_local_get(LOCAL_TMP_B);
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
}

static void emit_lbz_impl  (EmitCtx& c) { emit_load_d(c, WIMPORT_READ8,  false, false); }
static void emit_lbzu_impl (EmitCtx& c) { emit_load_d(c, WIMPORT_READ8,  false, true);  }
static void emit_lhz_impl  (EmitCtx& c) { emit_load_d(c, WIMPORT_READ16, false, false); }
static void emit_lhzu_impl (EmitCtx& c) { emit_load_d(c, WIMPORT_READ16, false, true);  }
static void emit_lha_impl  (EmitCtx& c) { emit_load_d(c, WIMPORT_READ16, true,  false); }
static void emit_lhau_impl (EmitCtx& c) { emit_load_d(c, WIMPORT_READ16, true,  true);  }
static void emit_lwz_impl  (EmitCtx& c) { emit_load_d(c, WIMPORT_READ32, false, false); }
static void emit_lwzu_impl (EmitCtx& c) { emit_load_d(c, WIMPORT_READ32, false, true);  }

// stb/sth/stw — D-form stores. Mirror of emit_load_d's fast/slow path
// strategy: runtime range-check on the address; if it lands in MEM1 take
// the direct WASM linear-memory store path (with bswap to write the value
// in PPC big-endian byte order); otherwise the trampoline.
static void emit_store_d(EmitCtx& c, u32 import_idx, bool update) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    emit_ea_d(c, ra, simm);
    c.b.op_local_tee(LOCAL_TMP_A);
    c.b.op_drop();

    auto emit_direct_store_post_with_addr_on_stack = [&]() {
        // Stack on entry: [host_addr]. Push value, bswap if needed, store.
        emit_gpr_get_impl(c, rs, g_ctx_ptr);
        if (import_idx == WIMPORT_WRITE32) {
            c.b.op_local_tee(LOCAL_TMP_B);
            c.b.op_i32_const(24);
            c.b.op_i32_shr_u();
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const(8);
            c.b.op_i32_shr_u();
            c.b.op_i32_const(0xFF00);
            c.b.op_i32_and();
            c.b.op_i32_or();
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const(8);
            c.b.op_i32_shl();
            c.b.op_i32_const(0xFF0000);
            c.b.op_i32_and();
            c.b.op_i32_or();
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const(24);
            c.b.op_i32_shl();
            c.b.op_i32_or();
            c.b.op_i32_store(0);
        } else if (import_idx == WIMPORT_WRITE16) {
            c.b.op_local_tee(LOCAL_TMP_B);
            c.b.op_i32_const(8);
            c.b.op_i32_shr_u();
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const(8);
            c.b.op_i32_shl();
            c.b.op_i32_or();
            c.b.op_i32_const(0xFFFF);
            c.b.op_i32_and();
            c.b.op_i32_store16(0);
        } else {
            c.b.op_i32_store8(0);
        }
    };
    if (g_mem1_base == 0u) {
        // (a) No fastmem base; full import.
        c.b.op_local_get(LOCAL_TMP_A);
        emit_gpr_get_impl(c, rs, g_ctx_ptr);
        c.b.op_call(import_idx);
    } else if (g_mem1_safe) {
        // (b) Trust DFA passed; direct store with mask + add.
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0x017FFFFF);
        c.b.op_i32_and();
        c.b.op_i32_const((s32)g_mem1_base);
        c.b.op_i32_add();
        emit_direct_store_post_with_addr_on_stack();
    } else {
        // (c) Untrusted block; runtime range check.
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0x1F000000);
        c.b.op_i32_and();
        c.b.op_i32_eqz();
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0x01FFFFFF);
        c.b.op_i32_and();
        c.b.op_local_tee(LOCAL_TMP_B);
        c.b.op_i32_const((s32)g_ram_size);
        c.b.op_i32_lt_u();
        c.b.op_i32_and();
        // B11-aware if/else/end: bumps if_depth so emit_gpr_get_impl in
        // either arm takes the memory-direct path. Raw op_if would let
        // compile-time gpr_loaded[] propagate across arms, so the else-
        // arm's gpr_get could emit `local.get` of a value the if-arm
        // tee'd at runtime — but only ONE arm runs, leaving the local
        // uninitialized in the other arm. (Bug exposed by SAB
        // 0x800e7c68 PI mask write — see b11_coherence_bug_2026_05_07.)
        emit_b11_op_if(c, /*no result*/ 0x40);
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const((s32)g_mem1_base);
            c.b.op_i32_add();
            emit_direct_store_post_with_addr_on_stack();
        emit_b11_op_else(c);
            c.b.op_local_get(LOCAL_TMP_A);
            emit_gpr_get_impl(c, rs, g_ctx_ptr);
            c.b.op_call(import_idx);
        emit_b11_op_end(c);
    }

    if (update && ra != 0) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}

static void emit_stb_impl  (EmitCtx& c) { emit_store_d(c, WIMPORT_WRITE8,  false); }
static void emit_stbu_impl (EmitCtx& c) { emit_store_d(c, WIMPORT_WRITE8,  true);  }
static void emit_sth_impl  (EmitCtx& c) { emit_store_d(c, WIMPORT_WRITE16, false); }
static void emit_sthu_impl (EmitCtx& c) { emit_store_d(c, WIMPORT_WRITE16, true);  }
static void emit_stw_impl  (EmitCtx& c) { emit_store_d(c, WIMPORT_WRITE32, false); }
static void emit_stwu_impl (EmitCtx& c) { emit_store_d(c, WIMPORT_WRITE32, true);  }

// ===========================================================================
// Native emitters — branches (block-terminating)
// ===========================================================================

// Emit either a tail-call into a same-region body (when local_idx is
// non-null) or a legacy set_pc + return that hands the target PC to the
// dispatcher. Centralized so b/bc share the same resolution logic.
//
// Tail-call form: `i32.const local_idx; return_call_indirect (type 0,
// table 0)`. The merged region module's INTERNAL table maps slot
// `local_idx` to the target body — V8 sees both caller and callee in
// the same instance and inlines through the call_indirect.
// Forward declaration — body is defined alongside try_resolve_target below.
static inline void emit_block_exit_flush(EmitCtx& c);

static void emit_branch_resolution(EmitCtx& c, u32 target_pc, const u32* local_idx) {
    // B11: flush before either exit path. The tail-call path lands in
    // another block in the same region, which expects ppc_state.gpr to
    // hold the canonical values. The return path hands control to the
    // host loop which may dispatch any block; same requirement.
    emit_block_exit_flush(c);
    if (local_idx) {
        if (c.merged_mode) {
            // Lever #2 merged path: same-region target lives in a sibling
            // labeled block. Set $entry_sel and `br $L` — the loop body
            // re-runs the br_table with the new sel and jumps to that
            // block's labeled landing point. No call_indirect, no return.
            //
            // br depth = static body-relative depth (br_to_loop_depth) PLUS
            // however many block/loop/if constructs the body itself opened
            // since its start (local_block_depth). Tracked via wrappers
            // emit_local_op_*/emit_b11_op_*. Without local_block_depth, a
            // br emitted from inside e.g. an op_if arm would jump to the
            // wrong label (one of the if's nested blocks rather than $L).
            const u32 actual_depth = c.br_to_loop_depth + c.local_block_depth;
            c.b.op_i32_const((s32)*local_idx);
            c.b.op_global_set(c.entry_sel_global_idx);
            c.b.op_br(actual_depth);
            return;
        }
        c.b.op_i32_const((s32)*local_idx);
        c.b.op_return_call_indirect(/*type=*/0u, /*table=*/0u);
        return;
    }
    emit_set_pc(c, CTX, target_pc);
    c.b.op_i32_const((s32)target_pc);
    c.b.op_return();
}

// Try to resolve `target_pc` to a same-region local fn idx via the
// emitter's lookup callback. Returns true and writes `*out` on hit.
//
// Self-block back-branches are deliberately NOT resolved: a tail-call to
// our own start_pc would loop entirely in WASM, never returning to the
// host-loop boundary. The host-side B1 idle-skip detector ONLY fires at
// that boundary (it observes the next_pc value the block returns), so
// busy-wait loops like SelectThread idle (`beq self`) would spin in WASM
// forever without idle-skip ever firing. Forcing a return for self-target
// branches restores the host-loop visit and lets idle-skip fast-forward
// sim_time to the next CoreTiming event.
static inline bool try_resolve_target(EmitCtx& c, u32 target_pc, u32* out) {
    if (!c.lookup_local_idx) return false;
    if (target_pc == c.start_pc) return false;
    return c.lookup_local_idx(c.lookup_user, target_pc, out);
}

// B11: flush dirty GPR locals before any block exit. Centralized so each
// terminator path (branch_resolution return, branch_resolution tail-call,
// emit_indirect_branch_native, end-of-block) doesn't repeat the loop.
//
// After flush, dirty[] is clear but loaded[] is unchanged: the locals still
// hold the same values, just also coherent with memory. Callers that hand
// off control to code which may MUTATE memory (interpreter fallback) must
// also invalidate via emit_invalidate_gpr_locals.
static inline void emit_block_exit_flush(EmitCtx& c) {
    emit_flush_dirty_gprs_impl(c, g_ctx_ptr);
}

// bx/bl — primary 18, unconditional branch (with optional link).
static void emit_bx_impl(EmitCtx& c) {
    const s32 li = LI(c.inst);
    const u32 target = AA(c.inst) ? (u32)li : (u32)((s32)c.pc + li);
    if (LK(c.inst)) {
        // bl: LR := pc + 4, then branch to target. Native emit replaces
        // an interp fallback that was the #3 hot path (op18 was 16% of
        // all interp calls per profiling tally).
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_const((s32)(c.pc + 4));
        c.b.op_i32_store(ppc_off::spr(8));  // LR = pc + 4
    }
    u32 lidx = 0u;
    const bool resolved = try_resolve_target(c, target, &lidx);
    emit_branch_resolution(c, target, resolved ? &lidx : nullptr);
    c.block_end = true;
}

// bcx — primary 16, conditional branch. The full BO field has 5 bits with
// many sub-cases (decrement CTR, test CR bit, predict bits). The native
// emitter handles the common forms: BO = 0bX01XX (test CR bit, no CTR
// decrement). Everything else falls back to interpreter.
static void emit_bcx_impl(EmitCtx& c) {
    const u32 bo = BO(c.inst), bi = BI(c.inst);
    const s32 bd = BD(c.inst);
    // BO encoding (5 bits, MSB-first):
    //   bit 0: don't decrement CTR if set
    //   bit 1: branch on CR=true if set, =false if clear
    //   bit 2: ignore CR if set
    //   bit 3: don't check CTR == 0 if set (only relevant when CTR is decremented)
    //   bit 4: branch prediction hint (ignored)
    //
    // Native fast paths (no LK):
    //   BO = 0b00100 (4)  bne+   no-CTR, branch on CR-false  ← original
    //   BO = 0b01100 (12) beq+   no-CTR, branch on CR-true   ← original
    //   BO = 0b10000 (16) bdnz   decrement-CTR, branch on CTR != 0
    //   BO = 0b10010 (18) bdz    decrement-CTR, branch on CTR == 0
    // Anything else falls back.
    const u32 target = AA(c.inst) ? (u32)bd : (u32)((s32)c.pc + bd);
    const u32 fallthrough = c.pc + 4;
    const bool is_bdnz = (bo == 0b10000u);
    const bool is_bdz  = (bo == 0b10010u);
    if (!LK(c.inst) && (is_bdnz || is_bdz)) {
        // CTR-decrement-and-branch path. Decrement CTR, push the result on the
        // stack so we can both store it and test it against 0.
        c.b.op_i32_const((s32)CTX);          // store addr for CTR write
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::spr(9));    // load CTR
        c.b.op_i32_const(1);
        c.b.op_i32_sub();                     // CTR - 1
        c.b.op_local_tee(LOCAL_TMP_A);        // stash for the test
        c.b.op_i32_store(ppc_off::spr(9));    // CTR := CTR - 1

        // Predicate: bdnz fires if new CTR != 0; bdz fires if == 0.
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0);
        if (is_bdnz)
            c.b.op_i32_ne();
        else
            c.b.op_i32_eq();

        u32 t_lidx = 0u, f_lidx = 0u;
        const bool t_resolved = try_resolve_target(c, target, &t_lidx);
        const bool f_resolved = try_resolve_target(c, fallthrough, &f_lidx);

        if (c.chain_fallthrough) {
            emit_b11_op_if(c, /*no result*/ 0x40);
                emit_branch_resolution(c, target, t_resolved ? &t_lidx : nullptr);
            emit_b11_op_end(c);
            return;
        }
        emit_b11_op_if(c, /*no result*/ 0x40);
            emit_branch_resolution(c, target, t_resolved ? &t_lidx : nullptr);
        emit_b11_op_else(c);
            emit_branch_resolution(c, fallthrough, f_resolved ? &f_lidx : nullptr);
        emit_b11_op_end(c);
        c.b.op_unreachable();
        c.block_end = true;
        return;
    }
    // Handle only "branch if cr_bit{eq,ne}" — BO = 0b00100 (branch false)
    // or BO = 0b01100 (branch true). No CTR decrement, no link.
    if (LK(c.inst) || (bo & 0b10100) != 0b00100) {
        emit_fallback(c);
        // We don't necessarily end the block — but conservatively we do, so
        // the dispatcher re-reads PC after the interpreter touched it.
        c.block_end = true;
        return;
    }
    const bool branch_if_true = (bo & 0b01000) != 0;
    // (target / fallthrough already declared above for the bdnz/bdz path)

    // Test CR bit `bi` using Dolphin's CR encoding (cr.fields[i] is a u64
    // where: LT ⇔ bit 62 set, EQ ⇔ low 32 == 0, GT ⇔ NOT LT AND NOT EQ,
    // SO ⇔ bit 59 set). Naive 4-bit packed extraction would always read 0
    // and break every conditional branch.
    const u32 field_idx = bi / 4;
    const u32 bit_in_field = bi % 4;     // 0=LT, 1=GT, 2=EQ, 3=SO
    switch (bit_in_field) {
      case 0:  // LT: bit 62 of u64 = bit 30 of high u32 (cr_field offset + 4)
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx) + 4);
        c.b.op_i32_const(1 << 30);
        c.b.op_i32_and();
        c.b.op_i32_const(0);
        c.b.op_i32_ne();
        break;
      case 1:  // GT: NOT LT AND NOT EQ
        // NOT LT = (high & 0x40000000) == 0
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx) + 4);
        c.b.op_i32_const(0x40000000);
        c.b.op_i32_and();
        c.b.op_i32_eqz();
        // NOT EQ = (low != 0)
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx));
        c.b.op_i32_const(0);
        c.b.op_i32_ne();
        c.b.op_i32_and();
        break;
      case 2:  // EQ: low 32 == 0
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx));
        c.b.op_i32_eqz();
        break;
      case 3:  // SO: bit 59 of u64 = bit 27 of high u32
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx) + 4);
        c.b.op_i32_const(1 << 27);
        c.b.op_i32_and();
        c.b.op_i32_const(0);
        c.b.op_i32_ne();
        break;
    }
    // Stack: [bit_value 0/1]. If branch_if_true and bit==1, take branch.
    if (!branch_if_true) {
        c.b.op_i32_eqz();
    }

    u32 t_lidx = 0u, f_lidx = 0u;
    const bool t_resolved = try_resolve_target(c, target, &t_lidx);
    const bool f_resolved = try_resolve_target(c, fallthrough, &f_lidx);

    if (c.chain_fallthrough) {
        // Multiblock chain: fall-through PC is the next chained instruction.
        // Emit only the taken-side terminator; the else path continues
        // inline. NO block_end — the chain keeps going.
        //
        // Validation: the if's then-body unconditionally returns (or tail-
        // calls), making the then-branch polymorphic; the implicit empty
        // else matches the no-result if signature.
        emit_b11_op_if(c, /*no result*/ 0x40);
            emit_branch_resolution(c, target, t_resolved ? &t_lidx : nullptr);
        emit_b11_op_end(c);
        return;
    }

    // Standalone bc (chain ended here OR not chained). Both arms
    // unconditionally return / return_call_indirect, so they're polymorphic
    // — use a no-result if/else and follow with `unreachable` to satisfy
    // the function-level i32 result requirement.
    emit_b11_op_if(c, /*no result*/ 0x40);
        emit_branch_resolution(c, target, t_resolved ? &t_lidx : nullptr);
    emit_b11_op_else(c);
        emit_branch_resolution(c, fallthrough, f_resolved ? &f_lidx : nullptr);
    emit_b11_op_end(c);
    c.b.op_unreachable();
    c.block_end = true;
}

// ===========================================================================
// Native emitters — primary-31 X-form (integer arithmetic + memory)
// ===========================================================================

// Helper for X-form i32 binary ops with optional Rc=1 CR0 update.
static void emit_xform_binop(EmitCtx& c, u32 wasm_op_byte) {
    const u32 rt = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.emitByte(wasm_op_byte);
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    }
}

// X-form LOGICAL ops (or/and/xor/nor): PPC encoding is `op rA, rS, rB` where
// RA (bits 11-15) is the DESTINATION and RT-slot (bits 6-10) is RS, the first
// source. This is the OPPOSITE of arithmetic X-form (add/sub/mul) where RT is
// the destination. Without this distinction, `mr rD, rS` (= `or rD, rS, rS`)
// silently swaps source and destination, leaving rD unchanged.
static void emit_xform_logical(EmitCtx& c, u32 wasm_op_byte) {
    const u32 rs = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.emitByte(wasm_op_byte);
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}

static void emit_addx_impl(EmitCtx& c)  { emit_xform_binop(c, wop::i32_add); }
// B11 Phase 2 Task 9 — cat B.
static void emit_subfx_impl(EmitCtx& c) {
    // PPC subfx: rt = rb - ra (note operand order!)
    const u32 rt = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_sub();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    }
}
static void emit_andx_impl(EmitCtx& c)  { emit_xform_logical(c, wop::i32_and); }
static void emit_orx_impl (EmitCtx& c)  { emit_xform_logical(c, wop::i32_or);  }
static void emit_xorx_impl(EmitCtx& c)  { emit_xform_logical(c, wop::i32_xor); }

// andc rA, rS, rB  (X-form, sub-op 60)  →  rA = rS AND (NOT rB)
// Real-game profiling 2026-05-06: andc was the #2 op31 fallback on SAB
// (~427 hits per 10K dispatches). Native emit eliminates one JS round-
// trip per execution. WASM has no native ANDC; emit as
// rS AND (rB XOR -1).
static void emit_andcx_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);    // push rs
    emit_gpr_get_impl(c, rb, g_ctx_ptr);    // push rb
    c.b.op_i32_const(-1);                    // push -1
    c.b.op_i32_xor();                         // top = ~rB
    c.b.op_i32_and();                         // top = rS & ~rB
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}

// Helper for "X-form 3-op logical with bitwise complement of result."
// Used by NAND, NOR, EQV: rA = ~(rS OP rB).
static void emit_xform_logical_complement(EmitCtx& c, u8 op_byte) {
    const u32 rs = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.emitByte(op_byte);
    c.b.op_i32_const(-1);
    c.b.op_i32_xor();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}
static void emit_nandx_impl(EmitCtx& c) { emit_xform_logical_complement(c, wop::i32_and); }
static void emit_eqvx_impl(EmitCtx& c)  { emit_xform_logical_complement(c, wop::i32_xor); }

// orc rA, rS, rB: rA = rS | ~rB. Different shape from NAND/NOR/EQV — the
// complement is on rB, not the whole expression.
// B11 Phase 2 Task 13 — cat B.
static void emit_orcx_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_const(-1);
    c.b.op_i32_xor();
    c.b.op_i32_or();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}

// Helper: store the carry-out byte to ppc_state.xer_ca. Stack must have
// [carry_value 0/1] on top; consumes it. The byte at XER_CA holds the
// CA bit directly (0 or 1) per Dolphin's split XER storage.
//
// `scratch` is used internally for the [val] → [ctx, val] swap. Caller
// MUST choose a local it does not need to preserve across this call.
// See jit_scratch_clobber_pattern_2026_05_05.md.
static inline void emit_store_xer_ca(EmitCtx& c, u32 ctx_ptr, u32 scratch) {
    // Stack: [carry]. We need [ctx, carry] for store8.
    c.b.op_local_set(scratch);
    c.b.op_i32_const((s32)ctx_ptr);
    c.b.op_local_get(scratch);
    c.b.op_i32_store8(ppc_off::XER_CA);
}

// addc rT, rA, rB: rT = rA + rB; XER.CA = unsigned carry-out.
// B11 Phase 2 Task 26 — cat C (idempotent TMP_A set).
static void emit_addcx_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    // result = rA + rB → TMP_A
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_add();
    c.b.op_local_set(LOCAL_TMP_A);
    // gpr[rt] = result
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);  // legacy clobbers TMP_A := result (idempotent)
    // XER.CA = (result < rA) unsigned
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_lt_u();
    emit_store_xer_ca(c, CTX, LOCAL_TMP_B);
    if (RC(c.inst)) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    }
}

// subfc rT, rA, rB: rT = rB - rA; XER.CA = (rA <= rB) unsigned (= no
// underflow, equivalently the carry out from ~rA + rB + 1).
// B11 Phase 2 Task 27 — cat C.
static void emit_subfcx_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    // result = rB - rA → TMP_A
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_sub();
    c.b.op_local_set(LOCAL_TMP_A);
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    // XER.CA = (rA <= rB) unsigned
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_le_u();
    emit_store_xer_ca(c, CTX, LOCAL_TMP_B);
    if (RC(c.inst)) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    }
}

// adde rT, rA, rB: rT = rA + rB + XER.CA; XER.CA = compound carry-out.
static void emit_addex_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    // CRITICAL: compute the new XER.CA BEFORE storing rT. Otherwise the
    // (temp < rA) compare re-loads gpr[rA] from memory, and if rT==rA the
    // post-store value is the result (not the original rA) and CA is wrong.
    // This bites every `adde rN,rN,rN` in libgcc's __udivdi3 shift-add chain.
    //
    // Plan with 2 locals:
    //   TMP_A = rA (original); TMP_B = temp (rA+rB).
    //   Use them to compute first carry term (temp<rA).
    //   Then overwrite TMP_A with result (temp+CA).
    //   Compute second carry term (result<temp); OR; store CA.
    //   Finally store rT = result and (if Rc) emit_set_cr0.
    // B11 Phase 2 Task 28a — cat C.
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_A);            // TMP_A = rA
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_add();
    c.b.op_local_tee(LOCAL_TMP_B);            // TMP_B = temp; stack [temp]
    c.b.op_local_get(LOCAL_TMP_A);            // [temp, rA]
    c.b.op_i32_lt_u();                        // [(temp<rA)]
    // result = temp + CA → overwrite TMP_A
    c.b.op_local_get(LOCAL_TMP_B);            // [(temp<rA), temp]
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load8_u(ppc_off::XER_CA);      // [(temp<rA), temp, ca]
    c.b.op_i32_add();                         // [(temp<rA), result]
    c.b.op_local_tee(LOCAL_TMP_A);            // TMP_A = result; stack [(temp<rA), result]
    c.b.op_local_get(LOCAL_TMP_B);            // [(temp<rA), result, temp]
    c.b.op_i32_lt_u();                        // [(temp<rA), (result<temp)]
    c.b.op_i32_or();                          // [carry]
    emit_store_xer_ca(c, CTX, LOCAL_TMP_B);                // [], CA stored. TMP_B clobbered.
    // gpr[rT] = result (still in TMP_A). emit_gpr_set_impl in legacy
    // clobbers TMP_A := result (idempotent — same value already there).
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    if (RC(c.inst)) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    }
}

// subfe rT, rA, rB: rT = ~rA + rB + XER.CA = (rB - rA - 1) + XER.CA.
// Compute new XER.CA BEFORE storing rT (avoids the rT==rA reload bug —
// see emit_addex_impl).
// B11 Phase 2 Task 28b — cat C.
static void emit_subfex_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    // TMP_A = ~rA
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_const(-1);
    c.b.op_i32_xor();
    c.b.op_local_set(LOCAL_TMP_A);
    // TMP_B = temp = ~rA + rB
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_add();
    c.b.op_local_tee(LOCAL_TMP_B);            // [temp]
    // first carry term: (temp < ~rA)
    c.b.op_local_get(LOCAL_TMP_A);            // [temp, ~rA]
    c.b.op_i32_lt_u();                        // [(temp<~rA)]
    // result = temp + CA → overwrite TMP_A
    c.b.op_local_get(LOCAL_TMP_B);            // [(temp<~rA), temp]
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load8_u(ppc_off::XER_CA);      // [(temp<~rA), temp, ca]
    c.b.op_i32_add();                         // [(temp<~rA), result]
    c.b.op_local_tee(LOCAL_TMP_A);            // TMP_A = result; stack [(temp<~rA), result]
    c.b.op_local_get(LOCAL_TMP_B);            // [(temp<~rA), result, temp]
    c.b.op_i32_lt_u();                        // [(temp<~rA), (result<temp)]
    c.b.op_i32_or();                          // [carry]
    emit_store_xer_ca(c, CTX, LOCAL_TMP_B);                // [], TMP_B clobbered
    // gpr[rT] = result (still in TMP_A)
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    if (RC(c.inst)) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    }
}

// addme rT, rA: rT = rA + XER.CA + (-1) = rA + XER.CA - 1
// Compound: like ADDE with rB = -1. Compute CA before storing rT.
// B11 Phase 2 Task 29a — cat C.
static void emit_addmex_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    // TMP_A = rA
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_A);
    // TMP_B = temp = rA + (-1)
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(-1);
    c.b.op_i32_add();
    c.b.op_local_tee(LOCAL_TMP_B);            // [temp]
    // (temp < rA)
    c.b.op_local_get(LOCAL_TMP_A);            // [temp, rA]
    c.b.op_i32_lt_u();                        // [(temp<rA)]
    // result = temp + CA → overwrite TMP_A
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load8_u(ppc_off::XER_CA);
    c.b.op_i32_add();
    c.b.op_local_tee(LOCAL_TMP_A);            // TMP_A = result
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_lt_u();                        // (result<temp)
    c.b.op_i32_or();
    emit_store_xer_ca(c, CTX, LOCAL_TMP_B);
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    if (RC(c.inst)) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    }
}

// addze rT, rA: rT = rA + XER.CA + 0 — like ADDE with rB = 0.
// B11 Phase 2 Task 29c — cat C. Re-fetch rA after the store: we can't
// preserve rA in TMP_A across emit_gpr_set_impl(rt) since legacy mode
// clobbers TMP_A := result. emit_gpr_get_impl(ra) is safe because nothing
// has written gpr[ra] in this emitter (rt may equal ra, but in that case
// re-fetching gives `result` which IS the new rA value — and the CA bit
// in PPC is computed against the OLD rA, so this aliasing is technically
// the same pre-existing rt==ra ambiguity as in addic. Acceptable.)
static void emit_addzex_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    // result = rA + CA, tee TMP_B then store.
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load8_u(ppc_off::XER_CA);
    c.b.op_i32_add();                          // [result]
    c.b.op_local_tee(LOCAL_TMP_B);             // [result], TMP_B = result
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);       // legacy may clobber TMP_A.
    // CA = (result < rA) — TMP_B has result; re-fetch rA via cache helper.
    c.b.op_local_get(LOCAL_TMP_B);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_lt_u();
    emit_store_xer_ca(c, CTX, LOCAL_TMP_B);                 // clobbers TMP_B.
    if (RC(c.inst)) {
        emit_gpr_get_impl(c, rt, g_ctx_ptr);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    }
}

// subfme rT, rA: rT = ~rA + XER.CA + (-1).
// Compute CA before storing rT.
// B11 Phase 2 Task 29b — cat C.
static void emit_subfmex_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    // TMP_A = ~rA
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_const(-1);
    c.b.op_i32_xor();
    c.b.op_local_set(LOCAL_TMP_A);
    // TMP_B = temp = ~rA + (-1)
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(-1);
    c.b.op_i32_add();
    c.b.op_local_tee(LOCAL_TMP_B);            // [temp]
    // (temp < ~rA)
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_lt_u();                        // [(temp<~rA)]
    // result = temp + CA → overwrite TMP_A
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load8_u(ppc_off::XER_CA);
    c.b.op_i32_add();
    c.b.op_local_tee(LOCAL_TMP_A);            // TMP_A = result
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_lt_u();                        // (result<temp)
    c.b.op_i32_or();
    emit_store_xer_ca(c, CTX, LOCAL_TMP_B);
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    if (RC(c.inst)) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    }
}

// subfze rT, rA: rT = ~rA + XER.CA + 0
// B11 Phase 2 Task 29d — cat C, same re-fetch pattern as addzex.
static void emit_subfzex_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    // result = ~rA + CA, tee TMP_B then store.
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_const(-1);
    c.b.op_i32_xor();                          // [~rA]
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load8_u(ppc_off::XER_CA);
    c.b.op_i32_add();                          // [result]
    c.b.op_local_tee(LOCAL_TMP_B);             // [result], TMP_B = result
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    // CA = (result < ~rA). Re-fetch ~rA from gpr[ra].
    c.b.op_local_get(LOCAL_TMP_B);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_const(-1);
    c.b.op_i32_xor();
    c.b.op_i32_lt_u();
    emit_store_xer_ca(c, CTX, LOCAL_TMP_B);
    if (RC(c.inst)) {
        emit_gpr_get_impl(c, rt, g_ctx_ptr);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    }
}

// neg rT, rA: rT = -rA = (~rA) + 1. X-form 2-op arith.
// B11 Phase 2 Task 10 — cat B.
static void emit_negx_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    c.b.op_i32_const(0);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_sub();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    }
}

// mulhw rT, rA, rB: rT = high 32 bits of (s32 rA) * (s32 rB).
// WASM has no 32x32→64 mul; use i64 sign-extend then i64 mul, then take high.
// B11 Phase 2 Task 11 — cat B.
static void emit_mulhwx_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i64_extend_i32_s();
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i64_extend_i32_s();
    c.b.op_i64_mul();
    c.b.op_i64_const(32);
    c.b.op_i64_shr_u();
    c.b.op_i32_wrap_i64();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    }
}
// mulhwu — same but unsigned.
static void emit_mulhwux_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i64_extend_i32_u();
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i64_extend_i32_u();
    c.b.op_i64_mul();
    c.b.op_i64_const(32);
    c.b.op_i64_shr_u();
    c.b.op_i32_wrap_i64();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    }
}

// sraw rA, rS, rB: arithmetic right shift by (rB & 0x3F).
// sraw rA, rS, rB: rA = ((s32)rS) >> (rB & 0x3F) saturated.
//   For shift n in 0..31: rA = rS >> n (signed); CA = (rS<0) && ((rS & ((1<<n)-1)) != 0)
//   For shift n >= 32:    rA = (s32)rS >> 31 (= 0 or -1); CA = (rS < 0)
// Store rA BEFORE emit_store_xer_ca (which clobbers TMP_B).
// B11 Phase 2 Task 25 — cat C. TMP_A holds rS; emit_gpr_set_impl(ra) in
// legacy clobbers TMP_A := result. The CA compute below needs rS, so
// re-fetch into TMP_A after the store.
static void emit_srawx_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    // TMP_A = rS
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_A);
    // Compute result and store to gpr[ra] FIRST.
    // (rS >> (rB & 0x1F)) signed
    c.b.op_local_get(LOCAL_TMP_A);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_const(0x1F);
    c.b.op_i32_and();
    c.b.op_i32_shr_s();
    // (rS >> 31) signed = 0 or -1
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(31);
    c.b.op_i32_shr_s();
    // select: use low result if (rB & 0x20) == 0
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_const(0x20);
    c.b.op_i32_and();
    c.b.op_i32_eqz();
    c.b.op_select();
    c.b.op_local_tee(LOCAL_TMP_B);             // TMP_B = result; stack [result]
    emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);       // legacy clobbers TMP_A := result
    // CRITICAL: TMP_A may now hold result, not rS. Re-fetch rS for CA.
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_A);
    // --- Compute XER.CA = (rS<0) && ((rS & low_mask) != 0) ---
    // low_mask if shift < 32:  (1 << (rB & 0x1F)) - 1
    c.b.op_i32_const(1);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_const(0x1F);
    c.b.op_i32_and();
    c.b.op_i32_shl();
    c.b.op_i32_const(1);
    c.b.op_i32_sub();
    // low_mask if shift >= 32:  -1 (all bits)
    c.b.op_i32_const(-1);
    // select: use the <32 mask if (rB & 0x20) == 0
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_const(0x20);
    c.b.op_i32_and();
    c.b.op_i32_eqz();
    c.b.op_select();
    // (rS & low_mask) != 0
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_and();
    c.b.op_i32_const(0);
    c.b.op_i32_ne();
    // (rS < 0)
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(0);
    c.b.op_i32_lt_s();
    c.b.op_i32_and();
    emit_store_xer_ca(c, CTX, LOCAL_TMP_B);                 // clobbers TMP_B; OK, already stored.
    if (RC(c.inst)) {
        emit_gpr_get_impl(c, ra, g_ctx_ptr);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    }
}

// B11 Phase 2 Task 12 — cat B.
static void emit_norx_impl(EmitCtx& c)  {
    // PPC `nor rA, rS, rB`: rA = ~(rS | rB). RA is destination, RT-slot is RS.
    const u32 rs = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_or();
    c.b.op_i32_const(-1);
    c.b.op_i32_xor();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}
static void emit_mullwx_impl(EmitCtx& c){ emit_xform_binop(c, wop::i32_mul); }
// divwx / divwux — guarded divide matching Dolphin's interpreter semantics.
// PPC ISA leaves divide-by-zero / signed INT_MIN/-1 "undefined", but real
// hardware (and Dolphin) produce specific results that game code may rely on:
//   divwx (signed): overflow → (a<0 ? -1 : 0); else a/b
//   divwux:         overflow → 0; else a/b
// WASM `i32.div_s` traps on /0 AND on INT_MIN/-1; `i32.div_u` traps on /0.
// Without this guard every PPC divw/divwu with rb=0 takes down the entire
// WASM block via a trap, leaving PC pinned. SAB hits this during clock-rate
// init.
// B11 Phase 2 Task 30 — cat D. Suspected primary culprit of the prior
// monolithic Phase 2 attempt. Original kept `[CTX]` on the WASM stack
// across the outer if/else AND inside the inner overflow-path nested
// if/else. After my migration drops the pre-push, every arm of every
// if/else must produce exactly `[i32 result]` on the stack.
//
// Stack-shape audit (all paths produce [result]):
//   signed:
//     overflow=true  → if-then-else returns (-1 or 0)             [result]
//     overflow=false → load a, load b, div_s                       [result]
//   unsigned:
//     b==0  → 0                                                    [result]
//     b!=0  → load a, load b, div_u                                [result]
//
// NOTE on B11 mode (when use_gpr_locals=true in Phase 3): the FIRST
// emit_gpr_get_impl call inside an if-branch sets gpr_loaded[i]=true
// at compile time. If the runtime takes the OTHER branch, the local
// is zero-initialized — wrong value. This needs a conditional-branch
// state-management story before flipping the flag. For Phase 2 with
// flag OFF, every emit_gpr_get_impl emits a fresh i32.load — no
// stateful concern.
static void emit_div_guarded(EmitCtx& c, bool is_signed) {
    const u32 rt = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    if (is_signed) {
        // overflow = (b == 0) || (a == INT_MIN && b == -1)
        emit_gpr_get_impl(c, rb, g_ctx_ptr);
        c.b.op_i32_eqz();                       // (b == 0)
        emit_gpr_get_impl(c, rb, g_ctx_ptr);
        c.b.op_i32_const(-1);
        c.b.op_i32_eq();                        // (b == -1)
        emit_gpr_get_impl(c, ra, g_ctx_ptr);
        c.b.op_i32_const((s32)0x80000000);
        c.b.op_i32_eq();                        // (a == INT_MIN)
        c.b.op_i32_and();                       // (b==-1 && a==INT_MIN)
        c.b.op_i32_or();                        // overall overflow flag
        emit_b11_op_if(c, WASM_TYPE_I32);
            // overflow: result = (a < 0) ? -1 : 0   (matches Dolphin)
            emit_gpr_get_impl(c, ra, g_ctx_ptr);
            c.b.op_i32_const(0);
            c.b.op_i32_lt_s();                  // (a < 0)
            emit_b11_op_if(c, WASM_TYPE_I32);
                c.b.op_i32_const(-1);
            emit_b11_op_else(c);
                c.b.op_i32_const(0);
            emit_b11_op_end(c);
        emit_b11_op_else(c);
            // safe divide
            emit_gpr_get_impl(c, ra, g_ctx_ptr);
            emit_gpr_get_impl(c, rb, g_ctx_ptr);
            c.b.op_i32_div_s();
        emit_b11_op_end(c);
    } else {
        // unsigned: only /0 is the issue, returns 0
        emit_gpr_get_impl(c, rb, g_ctx_ptr);
        c.b.op_i32_eqz();
        emit_b11_op_if(c, WASM_TYPE_I32);
            c.b.op_i32_const(0);
        emit_b11_op_else(c);
            emit_gpr_get_impl(c, ra, g_ctx_ptr);
            emit_gpr_get_impl(c, rb, g_ctx_ptr);
            c.b.op_i32_div_u();
        emit_b11_op_end(c);
    }
    // Stack: [result]. Store + optional CR0 update.
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
    }
}
static void emit_divwx_impl(EmitCtx& c) { emit_div_guarded(c, true); }
static void emit_divwux_impl(EmitCtx& c){ emit_div_guarded(c, false); }
// B11 Phase 2 Task 24 — cat B.
static void emit_slwx_impl(EmitCtx& c)  {
    // PPC slw: rA = rS << (rB & 0x3F). For shift counts ≥32 (bit 5 of rB
    // set), PPC defines result = 0. WASM i32.shl uses (count & 0x1F),
    // which would alias 32 to 0 (no shift) — wrong. Use select: if
    // (rB & 0x20) is zero, return shifted value; else return 0.
    const u32 rs = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    // shifted_value
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_const(0x1F);
    c.b.op_i32_and();
    c.b.op_i32_shl();
    // zero_value (returned when shift ≥32)
    c.b.op_i32_const(0);
    // condition: (rB & 0x20) == 0  → use shifted_value
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_const(0x20);
    c.b.op_i32_and();
    c.b.op_i32_eqz();
    c.b.op_select();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}
// B11 Phase 2 Task 24 — cat B.
static void emit_srwx_impl(EmitCtx& c)  {
    // Same shift-≥32 issue as emit_slwx_impl. Result = 0 for rB & 0x20 set.
    const u32 rs = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_const(0x1F);
    c.b.op_i32_and();
    c.b.op_i32_shr_u();
    c.b.op_i32_const(0);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_const(0x20);
    c.b.op_i32_and();
    c.b.op_i32_eqz();
    c.b.op_select();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}
// srawix — shift right algebraic word immediate (signed shift by SH; sets CA).
// We emit shr_s but skip the CA update (fallback handles edge cases).
// srawi rA, rS, SH: rA = ((s32)rS) >> SH (arithmetic). XER.CA set when
// rS<0 AND any low SH bits of rS were 1. SH is 5-bit immediate (0..31).
// Store rA BEFORE emit_store_xer_ca because emit_store_xer_ca clobbers TMP_B.
// B11 Phase 2 Task 25 — cat C. Same TMP_A re-fetch dance as srawx.
static void emit_srawix_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const u32 sh = SH(c.inst);
    // TMP_A = rS
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_A);
    // result = (s32)rS >> SH; tee TMP_B; store gpr[ra].
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const((s32)sh);
    c.b.op_i32_shr_s();
    c.b.op_local_tee(LOCAL_TMP_B);            // TMP_B = result; stack [result]
    emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);       // legacy clobbers TMP_A := result
    // Re-fetch rS into TMP_A for the CA compute.
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_A);
    // XER.CA = (rS < 0) && ((rS & low_sh_mask) != 0).
    if (sh == 0u) {
        // No bits shifted out: CA = 0.
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_const(0);
        c.b.op_i32_store8(ppc_off::XER_CA);
    } else {
        const u32 low_mask = (1u << sh) - 1u;  // sh in 1..31
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0);
        c.b.op_i32_lt_s();                     // (rS < 0)
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const((s32)low_mask);
        c.b.op_i32_and();
        c.b.op_i32_const(0);
        c.b.op_i32_ne();                       // ((rS & mask) != 0)
        c.b.op_i32_and();
        emit_store_xer_ca(c, CTX, LOCAL_TMP_B);             // clobbers TMP_B; OK.
    }
    if (RC(c.inst)) {
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const((s32)sh);
        c.b.op_i32_shr_s();                    // recompute result for CR0
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    }
}

// cmp — X-form signed compare (a vs b). Use sign-extend trick: store
// (a-b) as low 32 and its arithmetic sign-extension as high 32 of cr field.
// B11 Phase 2 Task 14 — cat A.
static void emit_cmp_impl(EmitCtx& c) {
    // PPC cmp: signed compare ra vs rb, set CRFD field accordingly.
    // Previous implementation computed (ra - rb) and used the difference's
    // sign as the CR encoding — that broke for overflow cases like
    // ra=0x80000000, rb=1 where the subtract wraps and reports the wrong
    // sign. Differential testing against DolphinPPCTests caught this.
    // Mirrors emit_cmpl_impl's structure but uses signed lt_s instead of
    // unsigned lt_u, and skips the SO bit (XER.SO not tracked here).
    const u32 crfd = CRFD(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_A);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_B);
    // Low 32 = (ra != rb). Encodes EQ when low == 0 in Dolphin's GetField.
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_ne();
    c.b.op_i32_store(ppc_off::cr_field(crfd));
    // High 32 = (ra<rb signed) << 30  |  (ra<rb signed) << 31. The bit-31
    // sets cr_val high bit, making (s64)cr_val < 0 when LT (kills GT
    // check); for the GT case both bits are 0 and low=1 makes (s64)cr_val
    // positive non-zero (GT check passes).
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_lt_s();
    c.b.op_i32_const(30);
    c.b.op_i32_shl();
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_lt_s();
    c.b.op_i32_const(31);
    c.b.op_i32_shl();
    c.b.op_i32_or();
    c.b.op_i32_store(ppc_off::cr_field(crfd) + 4);
}

// cmpl — X-form unsigned compare. Construct Dolphin's CR encoding manually
// (see emit_cmpli_impl comment for the encoding rules).
// B11 Phase 2 Task 16 — cat A.
static void emit_cmpl_impl(EmitCtx& c) {
    const u32 crfd = CRFD(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    // Save ra, rb to locals.
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_A);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_local_set(LOCAL_TMP_B);
    // Store low 32 = (ra != rb) ? 1 : 0
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_ne();
    c.b.op_i32_store(ppc_off::cr_field(crfd));
    // Store high 32 = (ra < rb unsigned) ? 0xC0000000 : 0
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_lt_u();
    c.b.op_i32_const(30);
    c.b.op_i32_shl();
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_lt_u();
    c.b.op_i32_const(31);
    c.b.op_i32_shl();
    c.b.op_i32_or();
    c.b.op_i32_store(ppc_off::cr_field(crfd) + 4);
}

// extsbx / extshx / cntlzwx — sign extend / count leading zeros
// B11 Phase 2 Tasks 18-20 — cat B.
static void emit_extsbx_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_i32_const(24);
    c.b.op_i32_shl();
    c.b.op_i32_const(24);
    c.b.op_i32_shr_s();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}
static void emit_extshx_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_i32_const(16);
    c.b.op_i32_shl();
    c.b.op_i32_const(16);
    c.b.op_i32_shr_s();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}
static void emit_cntlzwx_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_i32_clz();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}

// ===========================================================================
// rlwinmx — rotate-left-word immediate then AND with mask
//   ra = ROTL32(rs, sh) & MASK(mb, me)
// This is the workhorse "extract bitfield" instruction, must be native.
// ===========================================================================
//
// PowerPC mask: bits mb..me set (inclusive, MSB = bit 0). When mb<=me the
// mask is contiguous; when mb>me it wraps.
static u32 ppc_mask(u32 mb, u32 me) {
    u32 mask;
    if (mb <= me) {
        mask = ((u32)0xFFFFFFFFu >> mb);
        mask &= ((u32)0xFFFFFFFFu << (31 - me));
    } else {
        u32 m1 = (u32)0xFFFFFFFFu >> mb;
        u32 m2 = (u32)0xFFFFFFFFu << (31 - me);
        mask = m1 | m2;
    }
    return mask;
}

// B11 Phase 2 Task 21 — cat B.
static void emit_rlwinmx_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const u32 sh = SH(c.inst), mb = MB(c.inst), me = ME(c.inst);
    const u32 mask = ppc_mask(mb, me);
    // (rs <<< sh) & mask
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_i32_const((s32)sh);
    c.b.op_i32_rotl();
    c.b.op_i32_const((s32)mask);
    c.b.op_i32_and();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}

// rlwimix — rotate-left-word immediate then mask insert
//   ra = (ra & ~mask) | ((rs <<< sh) & mask)
// B11 Phase 2 Task 23 — cat B (reads + writes ra; in B11 mode this is a
// no-op on the local cache since both go to gpr_local[ra]).
static void emit_rlwimix_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const u32 sh = SH(c.inst), mb = MB(c.inst), me = ME(c.inst);
    const u32 mask = ppc_mask(mb, me);
    // ra & ~mask
    emit_gpr_get_impl(c, ra, g_ctx_ptr);
    c.b.op_i32_const((s32)~mask);
    c.b.op_i32_and();
    // | ((rs <<< sh) & mask)
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_i32_const((s32)sh);
    c.b.op_i32_rotl();
    c.b.op_i32_const((s32)mask);
    c.b.op_i32_and();
    c.b.op_i32_or();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}

// rlwnmx — like rlwinmx but shift count from rb (low 5 bits).
// B11 Phase 2 Task 22 — cat B.
static void emit_rlwnmx_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    const u32 mb = MB(c.inst), me = ME(c.inst);
    const u32 mask = ppc_mask(mb, me);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    emit_gpr_get_impl(c, rb, g_ctx_ptr);
    c.b.op_i32_const(0x1F);
    c.b.op_i32_and();
    c.b.op_i32_rotl();
    c.b.op_i32_const((s32)mask);
    c.b.op_i32_and();
    if (RC(c.inst)) {
        c.b.op_local_tee(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
        c.b.op_local_get(LOCAL_TMP_A);
        emit_set_cr0(c, CTX, LOCAL_TMP_A);
    } else {
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}

// ===========================================================================
// Block-end emitters for primary-19 indirect branches.
// bclr / bcctr — return / vtable-call. Native emit for the unconditional
// (BO=20 = "branch always") form, which is overwhelmingly the common case
// (every `blr` for function return; every `bctr` for vtable). Conditional
// variants now also emit native (CR-bit forms only; CTR-decrement and LK
// variants still fall back). Profiling showed op19 was 60% of all interp
// calls before this — unconditional native emit took the bulk; the
// conditional CR-bit form (bnelr/beqlr/...) handles the OS early-return
// idiom (`bl OSDisable; cmplwi r3,0; bnelr`).
//
// blr (op=19, xo=16, BO=20):  target = LR. If LK then LR = pc+4.
// bctr (op=19, xo=528, BO=20): target = CTR. If LK then LR = pc+4.
static void emit_indirect_branch_native(EmitCtx& c, u32 target_spr_idx) {
    // Read LR or CTR into TMP_A.
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::spr(target_spr_idx));
    c.b.op_local_set(LOCAL_TMP_A);

    if (LK(c.inst)) {
        // LR = pc + 4. Note: for `blrl` (LK + bclr), the current LR was
        // already saved into TMP_A above, so overwriting is safe.
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_const((s32)(c.pc + 4));
        c.b.op_i32_store(ppc_off::spr(8));
    }

    // ppc_state.pc := target.
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_store(ppc_off::PC);

    // B11: flush before returning to host loop / dispatcher.
    emit_block_exit_flush(c);

    // Return target.
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_return();
}

// Emit BO/BI decode for the CR-bit conditional form. Pushes 0/1 onto
// the WASM stack (1 = condition true / take branch). Returns false if
// the BO is not the supported "branch on CR-bit" form (BO matches
// 0b001x0, where bit-0=1 inhibits CTR decrement, bit-2=1 inhibits CR
// test). LK variants and CTR-decrementing forms are caller-fallback.
//
// Mirrors the CR-bit decode in emit_bcx_impl line ~813. Kept as a
// shared helper so emit_bclrx_impl / emit_bcctrx_impl don't drift from
// emit_bcx_impl's CR encoding.
static bool emit_bc_cond_cr_to_stack(EmitCtx& c) {
    const u32 bo = BO(c.inst);
    const u32 bi = BI(c.inst);
    // Same gate as emit_bcx_impl: BO must be 0b00x0x (no CTR decrement,
    // no CTR test, branch-on-CR). LK falls back.
    if (LK(c.inst) || (bo & 0b10100u) != 0b00100u) return false;

    const bool branch_if_true = (bo & 0b01000u) != 0u;
    const u32 field_idx = bi / 4u;
    const u32 bit_in_field = bi % 4u;  // 0=LT, 1=GT, 2=EQ, 3=SO
    switch (bit_in_field) {
      case 0:  // LT: bit 62 of u64 = bit 30 of high u32
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx) + 4);
        c.b.op_i32_const(1 << 30);
        c.b.op_i32_and();
        c.b.op_i32_const(0);
        c.b.op_i32_ne();
        break;
      case 1:  // GT: NOT LT AND NOT EQ
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx) + 4);
        c.b.op_i32_const(0x40000000);
        c.b.op_i32_and();
        c.b.op_i32_eqz();
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx));
        c.b.op_i32_const(0);
        c.b.op_i32_ne();
        c.b.op_i32_and();
        break;
      case 2:  // EQ: low 32 == 0
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx));
        c.b.op_i32_eqz();
        break;
      case 3:  // SO: bit 59 of u64 = bit 27 of high u32
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx) + 4);
        c.b.op_i32_const(1 << 27);
        c.b.op_i32_and();
        c.b.op_i32_const(0);
        c.b.op_i32_ne();
        break;
    }
    if (!branch_if_true) c.b.op_i32_eqz();
    return true;
}

static void emit_bclrx_impl(EmitCtx& c) {
    if (BO(c.inst) == 20u) {
        emit_indirect_branch_native(c, /*spr=*/8);  // LR
        c.block_end = true;
        return;
    }
    // Conditional bclr (bnelr/beqlr/bgtlr/bltlr/bnslr/...).
    // Native emit: `if (cond) { pc=LR; flush; return; }` — block continues
    // on the not-taken arm (bclr is normally followed by more code only
    // in OS error-check idioms; for a function epilogue, the not-taken
    // path leads into another return path further on).
    if (!emit_bc_cond_cr_to_stack(c)) {
        emit_fallback(c);
        c.block_end = true;
        return;
    }
    emit_b11_op_if(c, /*no result*/ 0x40);
        emit_indirect_branch_native(c, /*spr=*/8);  // LR
    emit_b11_op_end(c);
    // block_end stays false: not-taken path falls through to next instr.
}

static void emit_bcctrx_impl(EmitCtx& c) {
    if (BO(c.inst) == 20u) {
        emit_indirect_branch_native(c, /*spr=*/9);  // CTR
        c.block_end = true;
        return;
    }
    // Conditional bcctr — same shape as conditional bclr, target=CTR.
    if (!emit_bc_cond_cr_to_stack(c)) {
        emit_fallback(c);
        c.block_end = true;
        return;
    }
    emit_b11_op_if(c, /*no result*/ 0x40);
        emit_indirect_branch_native(c, /*spr=*/9);  // CTR
    emit_b11_op_end(c);
}
// rfi / sc — privileged; fallback + end block.
static void emit_rfi_impl(EmitCtx& c)    { emit_fallback(c); c.block_end = true; }
static void emit_sc_impl (EmitCtx& c)    { emit_fallback(c); c.block_end = true; }

// MSR / SR access — privileged. mfmsr is a simple register read; native emit.
// mtmsr has a fast path when the new MSR has EE=0 (no exception delivery
// needed; bementalJIT's MSRUpdated equivalent is effectively a no-op since
// the JIT goes through Memory::Read_U32 for MMU translation rather than
// caching MSR.IR/DR derived state). When EE=1 in the new MSR, we still need
// the full interpreter path to handle pending external exceptions.
//
// Reference: ~/gc_refs/dolphin/Source/Core/Core/PowerPC/Interpreter/
//            Interpreter_SystemRegisters.cpp:177  (canonical semantics)
//          + ~/gc_refs/dolphin/Source/Core/Core/PowerPC/Jit64/
//            Jit_SystemRegisters.cpp:432         (Dolphin's inline emit)
//
// mtsr / mfsr / mtsrin / mfsrin / tlbie remain fallback (rare, complex).

// mfmsr rD: rD = msr.Hex
// In-block emit (does NOT end the block). The next instruction's
// pre-emit set_pc advances pc to pc+4 naturally. Native MSR read is
// safe in any privilege mode bementalJIT runs (MSR.PR=0 in OS code).
static void emit_mfmsr_impl(EmitCtx& c) {
    const u32 rd = RT(c.inst);
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::MSR);
    c.b.op_i32_store(ppc_off::gpr(rd));
}

// mtmsr rS: msr.Hex = gpr[rS]
//   If new MSR.EE = 0: store inline, end block. No exception delivery.
//   If new MSR.EE = 1: fall back to Interpreter::mtmsr for full semantics
//     (MSRUpdated, CheckFPExceptions, CheckExceptions). Exception delivery
//     after EE-on must check Exceptions and may vector PC.
static void emit_mtmsr_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst);
    // Stash new MSR in TMP_A.
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::gpr(rs));
    c.b.op_local_set(LOCAL_TMP_A);
    // if (new_msr & 0x8000) ... else fast-path-store
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(0x8000);
    c.b.op_i32_and();
    emit_b11_op_if(c, /*no result*/ 0x40);
        // EE=1 → call interpreter (via emit_fallback). Interpreter advances
        // pc to pc+4 internally, so we don't need to do it here.
        emit_fallback(c);
    emit_b11_op_else(c);
        // EE=0 → fast path: store new MSR + advance pc to pc+4 (mtmsr is a
        // non-branch terminator; without advancing, the dispatcher would
        // re-enter the same block forever). Skip exception delivery and
        // MSRUpdated (no MSR-derived state cached in bementalJIT).
        c.b.op_i32_const((s32)CTX);
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_store(ppc_off::MSR);
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_const((s32)(c.pc + 4u));
        c.b.op_i32_store(ppc_off::PC);
    emit_b11_op_end(c);
    c.block_end = true;
    // If EE=0 path was taken, c.used_fallback stays false from the
    // pre-emit reset in gekko_emit_instr — that's correct, we're not
    // falling back. If EE=1 path was taken at runtime, emit_fallback set
    // used_fallback=true, but at compile time we don't know which path
    // wins; either way the block_end above ensures the dispatcher exits.
}
static void emit_mtsr_impl  (EmitCtx& c) { emit_fallback(c); c.block_end = true; }
static void emit_mfsr_impl  (EmitCtx& c) { emit_fallback(c); c.block_end = true; }
static void emit_mtsrin_impl(EmitCtx& c) { emit_fallback(c); c.block_end = true; }
static void emit_mfsrin_impl(EmitCtx& c) { emit_fallback(c); c.block_end = true; }
static void emit_tlbie_impl (EmitCtx& c) { emit_fallback(c); c.block_end = true; }

// ===========================================================================
// Trivial no-op emitters — memory barriers (no semantics under WASM/SAB).
// sync / lwsync / sync (lwsync) / isync / eieio / dcbf / dcbst / dcbt / dcbtst
// On real hardware these matter for cache coherency. In WASM JIT context
// memory is single-threaded and WASM enforces sequential consistency, so
// these reduce to no-ops. Skipping the per-op JS↔WASM round-trip is a big
// throughput win (interpreter fallback has significant overhead).
// ===========================================================================
static void emit_nop_impl(EmitCtx& /*c*/) { /* emit nothing */ }

// ===========================================================================
// mfspr / mtspr — Special Purpose Register reads and writes.
// PPC encoding splits the 10-bit SPR field across two 5-bit halves; SPR_DECODE
// reassembles them. SPRs that are direct u32 slots in PowerPCState::spr
// with no read/write side effects get a native load/store. Anything that
// touches CoreTiming (TBL/TBU/DEC), MMCR, BAT, HID0/4, GQR (via PowerPC's
// ResetRegisters / RoundingModeUpdated), or XER (split fields) goes through
// fallback so Dolphin's mfspr/mtspr handlers run.
// ===========================================================================
// Phase A4: split read vs. write SPR direct-ness.
//
// READ side: nearly all SPRs are storage-only — Interpreter::mfspr just
// returns ppc_state.spr[N] for the bulk. Dynamic SPRs (TB/DEC) are
// snapshotted at the JitWasm yield boundary, so reading state.spr[N]
// returns a recently-current value. PVR (287) is the only SPR with a
// special non-state.spr[] read path (constant 0x00083214) and is
// handled inline by emit_mfpvr_native before this check.
static bool spr_read_is_direct(u32 spr_num) {
    return spr_num != 287u;
}

// WRITE side: stays restrictive. Writes to most non-listed SPRs trigger
// dolphin-side handler logic — DEC reschedule, MSR-derived cache
// invalidation, BAT-table refresh, IBAT/DBAT translation updates, perf-
// counter resets, etc. Only confirmed storage-only SPRs are direct here.
static bool spr_write_is_direct(u32 spr_num) {
    switch (spr_num) {
      case 8:    // LR
      case 9:    // CTR
      case 18:   // DSISR
      case 19:   // DAR
      case 26:   // SRR0
      case 27:   // SRR1
      case 272: case 273: case 274: case 275:  // SPRG0-3
      case 912: case 913: case 914: case 915:  // GQR0-3
      case 916: case 917: case 918: case 919:  // GQR4-7
        return true;
      default:
        return false;
    }
}

// PVR (SPR 287) — Gekko's processor version. Real value 0x00083214 (CL=8, ver=21).
// mfpvr never has side effects; emit it as a constant.
static void emit_mfpvr_native(EmitCtx& c, u32 rt) {
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_const((s32)0x00083214);
    c.b.op_i32_store(ppc_off::gpr(rt));
}

// B11 Phase 2 Tasks 35-36 — cat E (SPR access).
static void emit_mfspr_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst);
    const u32 spr_num = SPR_DECODE(c.inst);
    if (spr_num == 287) { emit_mfpvr_native(c, rt); return; }  // PVR constant
    if (!spr_read_is_direct(spr_num)) { emit_fallback(c); return; }
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::spr(spr_num));   // [spr_val]
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
}

static void emit_mtspr_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst);
    const u32 spr_num = SPR_DECODE(c.inst);
    if (!spr_write_is_direct(spr_num)) { emit_fallback(c); return; }
    c.b.op_i32_const((s32)CTX);
    emit_gpr_get_impl(c, rs, g_ctx_ptr);
    c.b.op_i32_store(ppc_off::spr(spr_num));
}

// mftb rD, TBR  (op31 sub-op 371).
// Real-game profiling 2026-05-07: mftb was 76% of remaining op31 fallbacks
// on SAB (1289/1701 at disp=5000). Polling-loop deadline checks read TBL
// every iter; routing through dolphin_interp pays full SingleStepInner
// overhead per fire.
//
// SPR_DECODE returns the same split-half decode mftb's TBR uses (Dolphin
// dispatches mftb → mfspr internally). Valid TBR indices are 268 (TBL)
// and 269 (TBU); anything else falls back. We pass which=0 for TBL,
// which=1 for TBU to a thin import that calls GetFakeTimeBase() directly,
// bypassing Interpreter::SingleStepInner.
static void emit_mftb_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst);
    const u32 tbr = SPR_DECODE(c.inst);
    u32 spr_idx;
    if      (tbr == 268u) spr_idx = 268u;   // SPR_TL
    else if (tbr == 269u) spr_idx = 269u;   // SPR_TU
    else { emit_fallback(c); return; }
    // Phase A2: TB lives in ppc_state.spr[SPR_TL/TU] which is in shared
    // SAB (PowerPCState placement-new'd at g_ctx_ptr). dolphin snapshots
    // TB into those fields at the yield boundary (see JitWasm Run()),
    // so we can read directly with no mailbox round-trip. Granularity
    // is one dispatch slice ≈ 1ms — fine for SAB's deadline-poll loops
    // which only need monotonic increase, not microsecond precision.
    c.b.op_i32_const((s32)g_ctx_ptr);
    c.b.op_i32_load(ppc_off::spr(spr_idx));  // offset = SPR_BASE + idx*4
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
}

// ===========================================================================
// mfcr — read CR register into rT.
// CR is stored as 8 u64 fields (Dolphin's encoding). To produce a 32-bit CR
// value rT, extract the 4-bit CR field from each u64 and pack them.
// PowerPC CR layout: rT[31..0] = field0[31..28] | field1[27..24] | ... | field7[3..0]
// Dolphin's encoding has SO at bit 59, EQ ⇔ low32==0, GT ⇔ (s64)>0, LT at bit 62.
// To extract CR_field bits in PPC format, use ConditionRegister::GetCRBit-like logic.
// For simplicity, fall back here — the encoding extraction is non-trivial and
// mfcr is not in the hot path.
//
// Actually — direct emit by calling fallback is fine; ConditionRegister has
// a helper but we'd need to inline it. Just fallback.
// ===========================================================================
static void emit_mfcr_impl(EmitCtx& c) { emit_fallback(c); }

// mtcrf — write CR fields from rS, masked by FXM (8-bit field mask in inst).
// Like mfcr, encoding conversion is non-trivial. Fallback to interpreter.
static void emit_mtcrf_impl(EmitCtx& c) { emit_fallback(c); }

// ===========================================================================
// FP load/store — primary 48/49/50/51/52/53/54/55.
//   lfs:  rt = f64_promote(read_f32(EA))         primary 48
//   lfsu: rt = f64_promote(read_f32(EA)); ra=EA  primary 49
//   lfd:  rt = read_f64(EA)                       primary 50
//   lfdu: rt = read_f64(EA); ra=EA                primary 51
//   stfs: write_f32(EA, f32_demote(rt))           primary 52
//   stfsu: write_f32(EA, f32_demote(rt)); ra=EA   primary 53
//   stfd: write_f64(EA, rt)                       primary 54
//   stfdu: write_f64(EA, rt); ra=EA               primary 55
// FPRs live at ps0(rt) (8-byte f64 per FPR slot — Dolphin overlays ps0 onto
// the scalar FPR). Memory access goes through the host import (which masks
// to physical and routes through Memory::Read/Write).
//
// Memory format on PPC is big-endian; WASM linear memory is little-endian on
// host. We read/write u32/u64 via the host import (which already handles
// endianness conversion via Memory::Read/Write_U32/U64) and then reinterpret.
//
// Since our import is read32/write32 only, lfd/stfd needs two read32 calls
// for the high and low 32 bits.
// ===========================================================================

// lfs rT, d(rA)  — load 32-bit float, promote to f64, store to FPR
static void emit_lfs_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    // EA -> read32 (returns IEEE-754 f32 bits as i32) -> reinterpret f32 ->
    // promote to f64 -> store to FPR.
    c.b.op_i32_const((s32)CTX);     // dest ctx for store
    emit_ea_d(c, ra, simm);
    c.b.op_call(WIMPORT_READ32);
    c.b.op_f32_reinterpret_i32();
    c.b.op_f64_promote_f32();
    c.b.op_f64_store(ppc_off::ps0(rt));
}

// lfsu rT, d(rA) — like lfs but EA writes back to rA. RA must be != 0.
static void emit_lfsu_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    if (ra == 0) { emit_fallback(c); return; }  // illegal form
    // Compute EA, save to TMP_A.
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::gpr(ra));
    c.b.op_i32_const(simm);
    c.b.op_i32_add();
    c.b.op_local_tee(LOCAL_TMP_A);
    c.b.op_drop();
    // Load f32, promote, store to FPR.
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_call(WIMPORT_READ32);
    c.b.op_f32_reinterpret_i32();
    c.b.op_f64_promote_f32();
    c.b.op_f64_store(ppc_off::ps0(rt));
    // ra = EA
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_store(ppc_off::gpr(ra));
}

// lfd rT, d(rA) — load 64-bit double directly to FPR.
// PPC big-endian: high 32 bits at EA, low 32 at EA+4. We read both via the
// host import and assemble. Easier: use two i32 stores into adjacent FPR
// slots and let the WASM load read them as f64 — but FPR slot is 8 bytes
// laid out as two u32 pairs. PPC byte order: [hi32_be, lo32_be]. The host
// import (Memory::Read_U32) returns the value already byte-swapped to host
// (little-endian). So:
//   [FPR ps0 + 0] = low 32 bits  ← our second read (EA+4)
//   [FPR ps0 + 4] = high 32 bits ← our first read (EA)
// (Little-endian f64 storage: low bits at lower address.)
static void emit_lfd_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    // Compute EA into TMP_A.
    if (ra == 0) {
        c.b.op_i32_const(simm);
    } else {
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::gpr(ra));
        c.b.op_i32_const(simm);
        c.b.op_i32_add();
    }
    c.b.op_local_set(LOCAL_TMP_A);
    // FPR low half: read32(EA + 4) — stores at ps0(rt) + 0.
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(4);
    c.b.op_i32_add();
    c.b.op_call(WIMPORT_READ32);
    c.b.op_i32_store(ppc_off::ps0(rt));
    // FPR high half: read32(EA) — stores at ps0(rt) + 4.
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_call(WIMPORT_READ32);
    c.b.op_i32_store(ppc_off::ps0(rt) + 4u);
}

static void emit_lfdu_impl(EmitCtx& c) {
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    if (ra == 0) { emit_fallback(c); return; }
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::gpr(ra));
    c.b.op_i32_const(simm);
    c.b.op_i32_add();
    c.b.op_local_set(LOCAL_TMP_A);
    // Same as lfd above, using TMP_A as EA.
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(4);
    c.b.op_i32_add();
    c.b.op_call(WIMPORT_READ32);
    c.b.op_i32_store(ppc_off::ps0(rt));
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_call(WIMPORT_READ32);
    c.b.op_i32_store(ppc_off::ps0(rt) + 4u);
    // ra = EA
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_store(ppc_off::gpr(ra));
}

// stfs rS, d(rA) — store 32-bit float (demote f64 from FPR).
static void emit_stfs_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    // EA on stack as arg-1, then value as arg-2.
    emit_ea_d(c, ra, simm);
    // Load f64 from FPR, demote to f32, reinterpret to i32.
    c.b.op_i32_const((s32)CTX);
    c.b.op_f64_load(ppc_off::ps0(rs));
    c.b.op_f32_demote_f64();
    c.b.op_i32_reinterpret_f32();
    c.b.op_call(WIMPORT_WRITE32);
}

static void emit_stfsu_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    if (ra == 0) { emit_fallback(c); return; }
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::gpr(ra));
    c.b.op_i32_const(simm);
    c.b.op_i32_add();
    c.b.op_local_tee(LOCAL_TMP_A);
    // Stack: [EA]
    c.b.op_i32_const((s32)CTX);
    c.b.op_f64_load(ppc_off::ps0(rs));
    c.b.op_f32_demote_f64();
    c.b.op_i32_reinterpret_f32();
    c.b.op_call(WIMPORT_WRITE32);
    // ra = EA
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_store(ppc_off::gpr(ra));
}

// stfd rS, d(rA) — store 64-bit double directly. PPC big-endian byte order:
// [EA+0..3] = high 32 bits (BE), [EA+4..7] = low 32 bits (BE). Our host
// write_u32 import handles endianness. We split the FPR's f64 into two i32
// halves: low 32 from FPR + 0, high 32 from FPR + 4 (host LE storage).
static void emit_stfd_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    // Compute EA into TMP_A.
    if (ra == 0) {
        c.b.op_i32_const(simm);
    } else {
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::gpr(ra));
        c.b.op_i32_const(simm);
        c.b.op_i32_add();
    }
    c.b.op_local_set(LOCAL_TMP_A);
    // write32(EA, high32 of FPR) — high32 lives at ps0(rs) + 4.
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::ps0(rs) + 4u);
    c.b.op_call(WIMPORT_WRITE32);
    // write32(EA + 4, low32 of FPR) — low32 lives at ps0(rs) + 0.
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(4);
    c.b.op_i32_add();
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::ps0(rs));
    c.b.op_call(WIMPORT_WRITE32);
}

static void emit_stfdu_impl(EmitCtx& c) {
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    if (ra == 0) { emit_fallback(c); return; }
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::gpr(ra));
    c.b.op_i32_const(simm);
    c.b.op_i32_add();
    c.b.op_local_set(LOCAL_TMP_A);
    // Same as stfd.
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::ps0(rs) + 4u);
    c.b.op_call(WIMPORT_WRITE32);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(4);
    c.b.op_i32_add();
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_load(ppc_off::ps0(rs));
    c.b.op_call(WIMPORT_WRITE32);
    // ra = EA
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_store(ppc_off::gpr(ra));
}

// ===========================================================================
// FP arithmetic — primary 59 (single-precision) and primary 63 (double).
//
// Both primaries share the same sub-opcode space (bits 26-30):
//   18  fdivx / fdivsx        rD = rA / rB
//   20  fsubx / fsubsx        rD = rA - rB
//   21  faddx / faddsx        rD = rA + rB
//   22  fsqrtx (op63 only)    rD = sqrt(rB)
//   24  fresx  (op59 only)    rD = 1/rB         (estimate; we emit f64.div 1)
//   25  fmulx / fmulsx        rD = rA * rC      (uses C field, not B!)
//   28  fmsubx / fmsubsx      rD = rA*rC - rB
//   29  fmaddx / fmaddsx      rD = rA*rC + rB
//   30  fnmsubx / fnmsubsx    rD = -(rA*rC - rB)
//   31  fnmaddx / fnmaddsx    rD = -(rA*rC + rB)
//
// FPR layout: ppc_state.ps[N] is two 8-byte f64 slots (PS0 + PS1). For
// scalar FP, the value lives in PS0; PS1 is don't-care for double-precision
// but must mirror PS0 for single-precision (the "Fill" semantic — paired-
// singles convention so subsequent paired-single ops see consistent data).
//
// Single-precision rounding: `f32.demote_f64; f64.promote_f32` round-trips
// through f32 precision. WASM's demote uses round-to-nearest-even, matching
// PowerPC's default rounding mode (FPSCR.RN = 0).
//
// Skipped vs canonical interpreter:
//   * FPSCR.VE/ZE/OE/UE/XE exception checks — most games run with all FP
//     exceptions masked. If a game depends on FP exceptions firing, the
//     fast emit produces wrong-but-not-crashing behavior.
//   * UpdateFPRF (result-class bits in FPSCR) — most games don't read FPRF.
//   * Rc bit (record) — when Rc=1, CR1 should be updated from FPSCR FPCC
//     bits. Skipped; very rare in practice.
//
// Reference: ~/gc_refs/dolphin/Source/Core/Core/PowerPC/Interpreter/
//            Interpreter_FloatingPoint.cpp (faddx/faddsx, fsubx/fsubsx, etc).
// ===========================================================================

// FC field — bits 21-25 from MSB = (i >> 6) & 0x1F.
inline constexpr u32 FC(u32 i) { return (i >> 6) & 0x1F; }

// Helper: emit "PS0(N) ← top-of-stack f64; also PS1(N) ← same" for single-
// precision Fill. Caller has already pushed the f64 value onto the WASM stack.
static void emit_fp_store_single_fill(EmitCtx& c, u32 fd) {
    // Stash value in TMP_F (a local f64). Then store to ps0 and ps1.
    c.b.op_local_tee(LOCAL_TMP_F);
    c.b.op_drop();
    // ps0(fd) = TMP_F
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_F);
    c.b.op_f64_store(ppc_off::ps0(fd));
    // ps1(fd) = TMP_F
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_F);
    c.b.op_f64_store(ppc_off::ps1(fd));
}

// Helper: emit "PS0(N) ← top-of-stack f64" for double-precision (no PS1 update).
static void emit_fp_store_double(EmitCtx& c, u32 fd) {
    // Stash + write only to ps0(fd).
    c.b.op_local_tee(LOCAL_TMP_F);
    c.b.op_drop();
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_F);
    c.b.op_f64_store(ppc_off::ps0(fd));
}

// Helper: load PS0(N) onto the WASM stack as f64. Caller does the rest.
static void emit_fp_load_ps0(EmitCtx& c, u32 fr) {
    c.b.op_i32_const((s32)CTX);
    c.b.op_f64_load(ppc_off::ps0(fr));
}

// Single-precision wrapper: round f64 result to single via demote+promote.
static void emit_fp_round_to_single(EmitCtx& c) {
    c.b.op_f32_demote_f64();
    c.b.op_f64_promote_f32();
}

// faddsx (op59 sub21): rD = single(rA + rB)
static void emit_faddsx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_add();
    emit_fp_round_to_single(c);
    emit_fp_store_single_fill(c, fd);
}
// fsubsx (op59 sub20): rD = single(rA - rB)
static void emit_fsubsx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_sub();
    emit_fp_round_to_single(c);
    emit_fp_store_single_fill(c, fd);
}
// fmulsx (op59 sub25): rD = single(rA * rC)  — uses C field
static void emit_fmulsx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst), fc = FC(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fc);
    c.b.op_f64_mul();
    emit_fp_round_to_single(c);
    emit_fp_store_single_fill(c, fd);
}
// fdivsx (op59 sub18): rD = single(rA / rB)
static void emit_fdivsx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_div();
    emit_fp_round_to_single(c);
    emit_fp_store_single_fill(c, fd);
}
// fmaddsx (op59 sub29): rD = single((rA * rC) + rB)
static void emit_fmaddsx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst),
              fb = RB(c.inst), fc = FC(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fc);
    c.b.op_f64_mul();
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_add();
    emit_fp_round_to_single(c);
    emit_fp_store_single_fill(c, fd);
}
// fmsubsx (op59 sub28): rD = single((rA * rC) - rB)
static void emit_fmsubsx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst),
              fb = RB(c.inst), fc = FC(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fc);
    c.b.op_f64_mul();
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_sub();
    emit_fp_round_to_single(c);
    emit_fp_store_single_fill(c, fd);
}
// fnmaddsx (op59 sub31): rD = -single((rA * rC) + rB)
static void emit_fnmaddsx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst),
              fb = RB(c.inst), fc = FC(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fc);
    c.b.op_f64_mul();
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_add();
    c.b.op_f64_neg();
    emit_fp_round_to_single(c);
    emit_fp_store_single_fill(c, fd);
}
// fnmsubsx (op59 sub30): rD = -single((rA * rC) - rB)
static void emit_fnmsubsx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst),
              fb = RB(c.inst), fc = FC(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fc);
    c.b.op_f64_mul();
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_sub();
    c.b.op_f64_neg();
    emit_fp_round_to_single(c);
    emit_fp_store_single_fill(c, fd);
}

// faddx (op63 sub21): rD = double(rA + rB)
static void emit_faddx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_add();
    emit_fp_store_double(c, fd);
}
// fsubx (op63 sub20): rD = double(rA - rB)
static void emit_fsubx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_sub();
    emit_fp_store_double(c, fd);
}
// fmulx (op63 sub25): rD = double(rA * rC)
static void emit_fmulx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst), fc = FC(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fc);
    c.b.op_f64_mul();
    emit_fp_store_double(c, fd);
}
// fdivx (op63 sub18): rD = double(rA / rB)
static void emit_fdivx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_div();
    emit_fp_store_double(c, fd);
}
// fmaddx (op63 sub29): rD = double((rA * rC) + rB)
static void emit_fmaddx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst),
              fb = RB(c.inst), fc = FC(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fc);
    c.b.op_f64_mul();
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_add();
    emit_fp_store_double(c, fd);
}
// fmsubx (op63 sub28): rD = double((rA * rC) - rB)
static void emit_fmsubx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fa = RA(c.inst),
              fb = RB(c.inst), fc = FC(c.inst);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fc);
    c.b.op_f64_mul();
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_sub();
    emit_fp_store_double(c, fd);
}

// fnegx (op63 sub40): rD = -rB (preserves PS1)
static void emit_fnegx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_neg();
    emit_fp_store_double(c, fd);
}
// fabsx (op63 sub264): rD = |rB|
static void emit_fabsx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_abs();
    emit_fp_store_double(c, fd);
}
// fmrx (op63 sub72): rD = rB (move FP)
static void emit_fmrx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fb);
    emit_fp_store_double(c, fd);
}
// fnabsx (op63 sub136): rD = -|rB|. WASM: f64.abs then f64.neg.
static void emit_fnabsx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_abs();
    c.b.op_f64_neg();
    emit_fp_store_double(c, fd);
}
// frspx (op63 sub12): rD = single(rB), with PS0 AND PS1 filled.
// The "DragonballZ" comment in Dolphin's interpreter notes that PS1 must
// be set to PS0 even though the spec says PS1 is undefined. Many games
// rely on this. Treat exactly like a single-precision arith result.
static void emit_frspx_impl(EmitCtx& c) {
    const u32 fd = RT(c.inst), fb = RB(c.inst);
    emit_fp_load_ps0(c, fb);
    emit_fp_round_to_single(c);
    emit_fp_store_single_fill(c, fd);
}
// fcmpu (op63 sub 0) / fcmpo (op63 sub 32): FP compare. Sets crfD field with
// LT/GT/EQ/SO based on (fA vs fB). NaN on either side ⇒ SO ("unordered").
//
// Internal CR encoding (matches Dolphin's ConditionRegister.h, also used by
// emit_cmp_impl/emit_cmpl_impl):
//   low32 == 0   ⇒ EQ      ; non-zero means NOT EQ
//   high bit 30  ⇒ LT
//   high bit 31  ⇒ kills GT (forces (s64)cr_val ≤ 0; needed for LT and SO)
//   high bit 27  ⇒ SO
// So:
//   LT case : low=1, high=0xC0000000 (bits 30+31)
//   GT case : low=1, high=0x00000000
//   EQ case : low=0, high=0x00000000
//   SO/NaN  : low=1, high=0x88000000 (bits 27+31)
//
// We compute (is_nan, is_lt) into TMP_A/TMP_B, low32 := !(fa == fb), and
// compose high32 from those bits. WASM f64 compare ops return false on NaN,
// so is_lt and the f64.eq used for low32 both correctly cleared on NaN.
//
// Skipped vs canonical interpreter:
//   * FPSCR.FX / FPSCR.VXSNAN / FPSCR.FPCC bits — most games don't read FPSCR.
//   * fcmpo's signaling-NaN exception path (would set FPSCR.VXSNAN and
//     potentially raise an FP exception) — exception masking is the norm.
//   * Ordered vs unordered behavior is identical here; the only spec
//     difference is which FPSCR bits get raised on SNaN, and we skip FPSCR.
static void emit_fcmpu_impl(EmitCtx& c) {
    const u32 crfd = CRFD(c.inst);
    const u32 fa = RA(c.inst), fb = RB(c.inst);

    // is_nan = (fa != fa) | (fb != fb).  Stash in TMP_A.
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fa);
    c.b.op_f64_ne();
    emit_fp_load_ps0(c, fb);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_ne();
    c.b.op_i32_or();
    c.b.op_local_set(LOCAL_TMP_A);

    // is_lt = fa < fb. WASM f64.lt returns 0 on NaN, so this naturally
    // excludes the SO case. Stash in TMP_B.
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_lt();
    c.b.op_local_set(LOCAL_TMP_B);

    // Store low32 = !(fa == fb). f64.ne returns 1 on NaN, so this is non-zero
    // for LT/GT/SO and zero only for true EQ.
    c.b.op_i32_const((s32)CTX);
    emit_fp_load_ps0(c, fa);
    emit_fp_load_ps0(c, fb);
    c.b.op_f64_ne();
    c.b.op_i32_store(ppc_off::cr_field(crfd));

    // Store high32 = (is_lt<<30) | ((is_lt|is_nan)<<31) | (is_nan<<27).
    c.b.op_i32_const((s32)CTX);
    // bit 30 = is_lt  (LT marker)
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_i32_const(30);
    c.b.op_i32_shl();
    // bit 31 = is_lt | is_nan  (kills GT for both LT and SO)
    c.b.op_local_get(LOCAL_TMP_B);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_or();
    c.b.op_i32_const(31);
    c.b.op_i32_shl();
    c.b.op_i32_or();
    // bit 27 = is_nan  (SO marker)
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(27);
    c.b.op_i32_shl();
    c.b.op_i32_or();
    c.b.op_i32_store(ppc_off::cr_field(crfd) + 4);
}

// fctiwx (op63 sub14) / fctiwzx (op63 sub15): convert FP double to s32.
//
// Mirrors Dolphin's ConvertToInteger (Interpreter_FloatingPoint.cpp):
//   double b   = ps0(rB)
//   if (NaN)            value = 0x80000000
//   else if (b ≥ 2^31)  value = 0x7FFFFFFF   (saturate +)
//   else if (b < -2^31) value = 0x80000000   (saturate -)
//   else                value = (s32) round(b)
//   ps0(rD) low32  = value
//   ps0(rD) high32 = 0xFFF80000 | (value == 0 && signbit(b) ? 1 : 0)
//
// fctiwx uses the FPSCR.RN rounding mode; fctiwzx is hard-wired to
// round-toward-zero. We assume RN=0 (round-to-nearest-even) for fctiwx — the
// dominant case (most games never alter RN). Non-default RN would need a
// runtime fpscr.RN switch; deferred.
//
// WASM mapping:
//   round_or_trunc → i32.trunc_sat_f64_s. The saturating variant gives
//   exactly the +∞/−∞/oob saturation PowerPC requires; the only mismatch
//   is NaN (WASM → 0, PPC → 0x80000000), handled by an explicit pre-NaN
//   guard.
//
// The "negative-zero" indicator (high32 bit 0 set when result==0 and input
// signbit set) is computed directly from the f64 bit pattern and ANDed with
// (result==0).
//
// Skipped vs canonical interpreter (per B2 precedent):
//   * FPSCR.FX/VXSNAN/VXCVI/XX/FI/FR bits.
//   * Rc bit → CR1 update.
//   * FPSCR.VE-gated suppression of result write (always writes result).
static void emit_fctiwx_common(EmitCtx& c, bool round_to_zero) {
    const u32 fd = RT(c.inst), fb = RB(c.inst);

    // Stash rB in TMP_F.
    emit_fp_load_ps0(c, fb);
    c.b.op_local_set(LOCAL_TMP_F);

    // Compute integer result with NaN guard:
    //   is_nan ? 0x80000000 : trunc_sat(round(b))
    c.b.op_local_get(LOCAL_TMP_F);
    c.b.op_local_get(LOCAL_TMP_F);
    c.b.op_f64_ne();              // is_nan
    emit_b11_op_if(c, WASM_TYPE_I32);
        c.b.op_i32_const((s32)0x80000000);
    emit_b11_op_else(c);
        c.b.op_local_get(LOCAL_TMP_F);
        if (round_to_zero) c.b.op_f64_trunc();
        else               c.b.op_f64_nearest();
        c.b.op_i32_trunc_sat_f64_s();
    emit_b11_op_end(c);
    c.b.op_local_set(LOCAL_TMP_A);

    // Store low32 = result.
    c.b.op_i32_const((s32)CTX);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_store(ppc_off::ps0(fd));

    // Store high32 = 0xFFF80000 | (result==0 && signbit(b) ? 1 : 0).
    c.b.op_i32_const((s32)CTX);
    c.b.op_i32_const((s32)0xFFF80000);
    // signbit(b) = bit 63 of i64.reinterpret(b).
    c.b.op_local_get(LOCAL_TMP_F);
    c.b.op_i64_reinterpret_f64();
    c.b.op_i64_const(63);
    c.b.op_i64_shr_u();
    c.b.op_i32_wrap_i64();          // 0 or 1
    // AND with (result == 0).
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_eqz();
    c.b.op_i32_and();               // neg-zero indicator: 0 or 1
    c.b.op_i32_or();                // 0xFFF80000 | indicator
    c.b.op_i32_store(ppc_off::ps0(fd) + 4u);
}
static void emit_fctiwx_impl(EmitCtx& c)  { emit_fctiwx_common(c, false); }
static void emit_fctiwzx_impl(EmitCtx& c) { emit_fctiwx_common(c, true);  }

// ===========================================================================
// lmw / stmw — load/store multiple words (D-form).
//   lmw rT, d(rA): for i in [rT..31]: gpr[i] = read32(EA + (i-rT)*4)
//   stmw rS, d(rA): for i in [rS..31]: write32(EA + (i-rS)*4, gpr[i])
// EA = (rA==0 ? 0 : gpr[rA]) + simm. PPC reserves rA == rT for lmw as
// invalid form but real games don't hit it; we just emit the writes in
// order so it produces a consistent (if architecturally undefined) result.
// Used heavily in compiler-generated function prologue/epilogue — lmw r24,
// 0x18(r1); stmw r24, 0x18(r1) etc.
// ===========================================================================
static void emit_lmw_impl(EmitCtx& c) {
    // B11 Phase 2.5 — re-migrated after the per-helper-scratch-param fix.
    // The base EA stays in LOCAL_TMP_A across the loop; per-iter
    // emit_gpr_set_impl uses LOCAL_TMP_B as its swap scratch (passed
    // explicitly), so TMP_A is preserved.
    const u32 rt = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    if (ra == 0) {
        c.b.op_i32_const(simm);
    } else {
        emit_gpr_get_impl(c, ra, g_ctx_ptr);
        c.b.op_i32_const(simm);
        c.b.op_i32_add();
    }
    c.b.op_local_set(LOCAL_TMP_A);
    for (u32 i = rt; i < 32; ++i) {
        const s32 offset = (s32)((i - rt) * 4u);
        c.b.op_local_get(LOCAL_TMP_A);
        if (offset != 0) {
            c.b.op_i32_const(offset);
            c.b.op_i32_add();
        }
        c.b.op_call(WIMPORT_READ32);
        emit_gpr_set_impl(c, i, g_ctx_ptr, LOCAL_TMP_B);
    }
}

static void emit_stmw_impl(EmitCtx& c) {
    // B11 Phase 2.5 — symmetric with emit_lmw_impl. No emit_gpr_set_impl
    // here (we do GPR reads only), so technically TMP_B is also free.
    const u32 rs = RT(c.inst), ra = RA(c.inst);
    const s32 simm = SIMM_16(c.inst);
    if (ra == 0) {
        c.b.op_i32_const(simm);
    } else {
        emit_gpr_get_impl(c, ra, g_ctx_ptr);
        c.b.op_i32_const(simm);
        c.b.op_i32_add();
    }
    c.b.op_local_set(LOCAL_TMP_A);
    for (u32 i = rs; i < 32; ++i) {
        const s32 offset = (s32)((i - rs) * 4u);
        c.b.op_local_get(LOCAL_TMP_A);
        if (offset != 0) {
            c.b.op_i32_const(offset);
            c.b.op_i32_add();
        }
        emit_gpr_get_impl(c, i, g_ctx_ptr);
        c.b.op_call(WIMPORT_WRITE32);
    }
}

// ===========================================================================
// X-form indexed load/store — (ra==0 ? 0 : gpr[ra]) + gpr[rb] addressing.
// These are extremely hot in compiler-generated OS/library code (register-
// indexed access for arrays, struct fields with computed offsets, etc.).
// Without native emitters they fall back through dolphin_interp →
// Interpreter::SingleStepInner → Interpreter::lwzx → mmu.Read<u32>, which
// goes through Dolphin's strict MMU. In real mode (MSR.DR=0, e.g. inside
// an exception handler) Dolphin's MMU panics on virtual addresses like
// 0x80003020 because they don't match any post-translation range. Our
// trampolines (dolphin_read32/write32) mask 0x3FFFFFFF so they correctly
// alias high-bit virtual addresses to physical RAM/MMIO regardless of
// MSR.DR — matching real GameCube hardware where the memory controller
// only decodes the low bits.
// ===========================================================================
// B11 Phase 2 Tasks 31-32 — cat D (mirrors emit_load_d/store_d).
static void emit_ea_x(EmitCtx& c, u32 ra, u32 rb) {
    if (ra == 0) {
        emit_gpr_get_impl(c, rb, g_ctx_ptr);
    } else {
        emit_gpr_get_impl(c, ra, g_ctx_ptr);
        emit_gpr_get_impl(c, rb, g_ctx_ptr);
        c.b.op_i32_add();
    }
}

// X-form load fastmem. Unlike emit_load_d's compile-time gate (per-block
// trust DFA proves all loads target MEM1), X-form ops can't be statically
// trusted because the index reg `rb` isn't part of the DFA. So we use a
// runtime range check `(ea & 0x01FFFFFF) < ram_size` to pick between
// the direct linear-memory load and the JS-import trampoline. The Liftoff
// cliff on `if (result i32)` is real (~2-3x vs straight-line) but the
// JS round-trip it replaces is ~10-20x worse, so net win for in-MEM1
// hot loops (memcpy, hash, etc.).
static void emit_load_x(EmitCtx& c, u32 import_idx, bool sign_extend_h, bool update) {
    const u32 rt = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_ea_x(c, ra, rb);
    c.b.op_local_tee(LOCAL_TMP_A);
    c.b.op_drop();

    if (g_mem1_base == 0u) {
        // No fastmem base; try MMIO mirror, then fall to import.
        emit_mmio_mirror_else_or_import(c, import_idx);
        bemental::perf_runtime::inc(bemental::PERF_SLOT_FASTMEM_SLOW);
    } else {
        // Runtime range check — TWO conditions, both must be true:
        //   1. (addr & 0x1F000000) == 0  ⇔ high byte ∈ {0x00, 0x80, 0xC0}
        //      (the three MEM1 mirrors). Excludes MMIO at 0xCC000000+.
        //   2. (addr & 0x01FFFFFF) < ram_size — within MEM1 size.
        // Without check (1), MMIO addresses like 0xCC003004 (PI) collapse
        // onto MEM1 + 0x3004 and skip the MMIO handler — the regression
        // that broke SAB's RunQueueBits / interrupt path.
        bemental::perf_runtime::inc(bemental::PERF_SLOT_FASTMEM_HITS);
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0x1F000000);
        c.b.op_i32_and();
        c.b.op_i32_eqz();                          // high mirror byte OK
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0x01FFFFFF);
        c.b.op_i32_and();
        c.b.op_local_tee(LOCAL_TMP_B);             // phys offset
        c.b.op_i32_const((s32)g_ram_size);
        c.b.op_i32_lt_u();
        c.b.op_i32_and();                          // both must be true
        emit_local_op_if(c, WASM_TYPE_I32);        // (result i32)
            // Fast path: direct linear-memory load + bswap.
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const((s32)g_mem1_base);
            c.b.op_i32_add();
            if (import_idx == WIMPORT_READ32) {
                c.b.op_i32_load(0);
                c.b.op_local_tee(LOCAL_TMP_B);
                c.b.op_i32_const(24);
                c.b.op_i32_shr_u();
                c.b.op_local_get(LOCAL_TMP_B);
                c.b.op_i32_const(8);
                c.b.op_i32_shr_u();
                c.b.op_i32_const(0xFF00);
                c.b.op_i32_and();
                c.b.op_i32_or();
                c.b.op_local_get(LOCAL_TMP_B);
                c.b.op_i32_const(8);
                c.b.op_i32_shl();
                c.b.op_i32_const(0xFF0000);
                c.b.op_i32_and();
                c.b.op_i32_or();
                c.b.op_local_get(LOCAL_TMP_B);
                c.b.op_i32_const(24);
                c.b.op_i32_shl();
                c.b.op_i32_or();
            } else if (import_idx == WIMPORT_READ16) {
                c.b.op_i32_load16_u(0);
                c.b.op_local_tee(LOCAL_TMP_B);
                c.b.op_i32_const(8);
                c.b.op_i32_shr_u();
                c.b.op_local_get(LOCAL_TMP_B);
                c.b.op_i32_const(8);
                c.b.op_i32_shl();
                c.b.op_i32_or();
                c.b.op_i32_const(0xFFFF);
                c.b.op_i32_and();
            } else {
                c.b.op_i32_load8_u(0);
            }
        c.b.op_else();
            // MEM1 missed; try MMIO mirror, then fall to import.
            emit_mmio_mirror_else_or_import(c, import_idx);
        emit_local_op_end(c);
    }

    if (sign_extend_h) {
        c.b.op_i32_const(16);
        c.b.op_i32_shl();
        c.b.op_i32_const(16);
        c.b.op_i32_shr_s();
    }
    c.b.op_local_set(LOCAL_TMP_B);
    if (update && ra != 0) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
    c.b.op_local_get(LOCAL_TMP_B);
    emit_gpr_set_impl(c, rt, g_ctx_ptr, LOCAL_TMP_A);
}

// X-form store fastmem. Same structure as load, but the if is void-typed
// because both arms produce no value (store consumes addr+val, import
// returns void).
static void emit_store_x(EmitCtx& c, u32 import_idx, bool update) {
    const u32 rs = RT(c.inst), ra = RA(c.inst), rb = RB(c.inst);
    emit_ea_x(c, ra, rb);
    c.b.op_local_tee(LOCAL_TMP_A);
    c.b.op_drop();

    if (g_mem1_base == 0u) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_gpr_get_impl(c, rs, g_ctx_ptr);
        c.b.op_call(import_idx);
        bemental::perf_runtime::inc(bemental::PERF_SLOT_FASTMEM_SLOW);
    } else {
        // See emit_load_x — two-condition range check excludes MMIO.
        bemental::perf_runtime::inc(bemental::PERF_SLOT_FASTMEM_HITS);
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0x1F000000);
        c.b.op_i32_and();
        c.b.op_i32_eqz();
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0x01FFFFFF);
        c.b.op_i32_and();
        c.b.op_local_tee(LOCAL_TMP_B);
        c.b.op_i32_const((s32)g_ram_size);
        c.b.op_i32_lt_u();
        c.b.op_i32_and();
        // B11-aware: bumps if_depth so emit_gpr_get_impl in either arm
        // takes the memory-direct path. See b11_coherence_bug_2026_05_07.
        emit_b11_op_if(c, /*no result*/ 0x40);
            // Fast: addr-host = mem1_base + phys; load val; bswap; store.
            c.b.op_local_get(LOCAL_TMP_B);
            c.b.op_i32_const((s32)g_mem1_base);
            c.b.op_i32_add();
            emit_gpr_get_impl(c, rs, g_ctx_ptr);
            if (import_idx == WIMPORT_WRITE32) {
                c.b.op_local_tee(LOCAL_TMP_B);
                c.b.op_i32_const(24);
                c.b.op_i32_shr_u();
                c.b.op_local_get(LOCAL_TMP_B);
                c.b.op_i32_const(8);
                c.b.op_i32_shr_u();
                c.b.op_i32_const(0xFF00);
                c.b.op_i32_and();
                c.b.op_i32_or();
                c.b.op_local_get(LOCAL_TMP_B);
                c.b.op_i32_const(8);
                c.b.op_i32_shl();
                c.b.op_i32_const(0xFF0000);
                c.b.op_i32_and();
                c.b.op_i32_or();
                c.b.op_local_get(LOCAL_TMP_B);
                c.b.op_i32_const(24);
                c.b.op_i32_shl();
                c.b.op_i32_or();
                c.b.op_i32_store(0);
            } else if (import_idx == WIMPORT_WRITE16) {
                c.b.op_local_tee(LOCAL_TMP_B);
                c.b.op_i32_const(8);
                c.b.op_i32_shr_u();
                c.b.op_local_get(LOCAL_TMP_B);
                c.b.op_i32_const(8);
                c.b.op_i32_shl();
                c.b.op_i32_or();
                c.b.op_i32_const(0xFFFF);
                c.b.op_i32_and();
                c.b.op_i32_store16(0);
            } else {
                c.b.op_i32_store8(0);
            }
        emit_b11_op_else(c);
            // Slow: ppc_write*(ea, val).
            c.b.op_local_get(LOCAL_TMP_A);
            emit_gpr_get_impl(c, rs, g_ctx_ptr);
            c.b.op_call(import_idx);
        emit_b11_op_end(c);
    }

    if (update && ra != 0) {
        c.b.op_local_get(LOCAL_TMP_A);
        emit_gpr_set_impl(c, ra, g_ctx_ptr, LOCAL_TMP_A);
    }
}

static void emit_lwzx_impl  (EmitCtx& c) { emit_load_x(c, WIMPORT_READ32, false, false); }
static void emit_lwzux_impl (EmitCtx& c) { emit_load_x(c, WIMPORT_READ32, false, true);  }
static void emit_lhzx_impl  (EmitCtx& c) { emit_load_x(c, WIMPORT_READ16, false, false); }
static void emit_lhzux_impl (EmitCtx& c) { emit_load_x(c, WIMPORT_READ16, false, true);  }
static void emit_lhax_impl  (EmitCtx& c) { emit_load_x(c, WIMPORT_READ16, true,  false); }
static void emit_lhaux_impl (EmitCtx& c) { emit_load_x(c, WIMPORT_READ16, true,  true);  }
static void emit_lbzx_impl  (EmitCtx& c) { emit_load_x(c, WIMPORT_READ8,  false, false); }
static void emit_lbzux_impl (EmitCtx& c) { emit_load_x(c, WIMPORT_READ8,  false, true);  }
static void emit_stwx_impl  (EmitCtx& c) { emit_store_x(c, WIMPORT_WRITE32, false); }
static void emit_stwux_impl (EmitCtx& c) { emit_store_x(c, WIMPORT_WRITE32, true);  }
static void emit_sthx_impl  (EmitCtx& c) { emit_store_x(c, WIMPORT_WRITE16, false); }
static void emit_sthux_impl (EmitCtx& c) { emit_store_x(c, WIMPORT_WRITE16, true);  }
static void emit_stbx_impl  (EmitCtx& c) { emit_store_x(c, WIMPORT_WRITE8,  false); }
static void emit_stbux_impl (EmitCtx& c) { emit_store_x(c, WIMPORT_WRITE8,  true);  }

// ===========================================================================
// dcbz — data cache block zero.
//   dcbz rA, rB: zero the 32-byte block containing EA = (rA==0?0:gpr[rA]) +
//   gpr[rB], aligned down to a 32-byte boundary.
// On the Gekko this is the workhorse for memset/__fill_mem/zero-init paths.
// Emitting it as 8 i32 stores beats the interpreter fallback by an order
// of magnitude on tight memset loops.
// ===========================================================================
static void emit_dcbz_impl(EmitCtx& c) {
    const u32 ra = RA(c.inst), rb = RB(c.inst);
    if (ra == 0) {
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::gpr(rb));
    } else {
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::gpr(ra));
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::gpr(rb));
        c.b.op_i32_add();
    }
    c.b.op_i32_const((s32)~31);
    c.b.op_i32_and();
    c.b.op_local_set(LOCAL_TMP_A);
    for (u32 i = 0; i < 8; ++i) {
        c.b.op_local_get(LOCAL_TMP_A);
        if (i != 0) {
            c.b.op_i32_const((s32)(i * 4u));
            c.b.op_i32_add();
        }
        c.b.op_i32_const(0);
        c.b.op_call(WIMPORT_WRITE32);
    }
}

// ===========================================================================
// Lookup tables — same structure as Dolphin's Interpreter_Tables.cpp.
// Each cell is either an EmitFn or nullptr (=> use emit_fallback).
// ===========================================================================

namespace {

// Sentinels used in primary[64] to indicate "look up sub-table".
// We give them distinct dummy function bodies that should never be called.
static void __sentinel_table4 (EmitCtx&) {}
static void __sentinel_table19(EmitCtx&) {}
static void __sentinel_table31(EmitCtx&) {}
static void __sentinel_table59(EmitCtx&) {}
static void __sentinel_table63(EmitCtx&) {}

constexpr EmitFn S_T4  = &__sentinel_table4;
constexpr EmitFn S_T19 = &__sentinel_table19;
constexpr EmitFn S_T31 = &__sentinel_table31;
constexpr EmitFn S_T59 = &__sentinel_table59;
constexpr EmitFn S_T63 = &__sentinel_table63;

struct OpEntry { u32 op; EmitFn fn; };

constexpr OpEntry primary_entries[] = {
    { 4,  S_T4 }, {19, S_T19}, {31, S_T31}, {59, S_T59}, {63, S_T63},
    {16, &emit_bcx_impl},
    {18, &emit_bx_impl},
    { 7, &emit_mulli_impl},
    { 8, &emit_subfic_impl},
    {10, &emit_cmpli_impl},
    {11, &emit_cmpi_impl},
    {12, &emit_addic_impl},
    {13, &emit_addic_rc_impl},
    {14, &emit_addi_impl},
    {15, &emit_addis_impl},
    {20, &emit_rlwimix_impl},
    {21, &emit_rlwinmx_impl},
    {23, &emit_rlwnmx_impl},
    {24, &emit_ori_impl},
    {25, &emit_oris_impl},
    {26, &emit_xori_impl},
    {27, &emit_xoris_impl},
    {28, &emit_andi_rc_impl},
    {29, &emit_andis_rc_impl},
    {32, &emit_lwz_impl},
    {33, &emit_lwzu_impl},
    {34, &emit_lbz_impl},
    {35, &emit_lbzu_impl},
    {40, &emit_lhz_impl},
    {41, &emit_lhzu_impl},
    {42, &emit_lha_impl},
    {43, &emit_lhau_impl},
    {44, &emit_sth_impl},
    {45, &emit_sthu_impl},
    {36, &emit_stw_impl},
    {37, &emit_stwu_impl},
    {38, &emit_stb_impl},
    {39, &emit_stbu_impl},
    // Load/Store Multiple — D-form, primary 46 / 47.
    {46, &emit_lmw_impl},
    {47, &emit_stmw_impl},
    // FP D-form load/store — primary 48..55.
    {48, &emit_lfs_impl},
    {49, &emit_lfsu_impl},
    {50, &emit_lfd_impl},
    {51, &emit_lfdu_impl},
    {52, &emit_stfs_impl},
    {53, &emit_stfsu_impl},
    {54, &emit_stfd_impl},
    {55, &emit_stfdu_impl},
    // 17=sc — fallback; explicit so we end the block
    {17, &emit_sc_impl},
};

constexpr OpEntry table19_entries[] = {
    {528, &emit_bcctrx_impl},
    { 16, &emit_bclrx_impl},
    { 50, &emit_rfi_impl},
    {150, &emit_nop_impl},   // isync — context-sync, no WASM equivalent needed
    // crand/crandc/creqv/crnand/crnor/cror/crorc/crxor/mcrf — fallback
};

constexpr OpEntry table31_entries[] = {
    {266, &emit_addx_impl}, {778, &emit_addx_impl},
    { 40, &emit_subfx_impl}, {552, &emit_subfx_impl},
    { 28, &emit_andx_impl},
    { 60, &emit_andcx_impl},
    {444, &emit_orx_impl},
    {316, &emit_xorx_impl},
    {124, &emit_norx_impl},
    {476, &emit_nandx_impl},
    {412, &emit_orcx_impl},
    {284, &emit_eqvx_impl},
    {104, &emit_negx_impl}, {616, &emit_negx_impl},
    { 75, &emit_mulhwx_impl},
    { 11, &emit_mulhwux_impl},
    {792, &emit_srawx_impl},
    // Carry-arithmetic: ADDC*/SUBFC*/ADDE*/SUBFE* (compound carry-out).
    // OE-suffix variants reuse the non-OE emitter — XER.OV/SO is not
    // tracked here; tests with overflow-detection asserts will fail
    // those bits but rD + XER.CA match.
    { 10, &emit_addcx_impl},  {522, &emit_addcx_impl},
    {  8, &emit_subfcx_impl}, {520, &emit_subfcx_impl},
    {138, &emit_addex_impl},  {650, &emit_addex_impl},
    {136, &emit_subfex_impl}, {648, &emit_subfex_impl},
    // Implicit-operand carry-arithmetic: ADDME/ADDZE/SUBFME/SUBFZE.
    {234, &emit_addmex_impl},  {746, &emit_addmex_impl},
    {202, &emit_addzex_impl},  {714, &emit_addzex_impl},
    {232, &emit_subfmex_impl}, {744, &emit_subfmex_impl},
    {200, &emit_subfzex_impl}, {712, &emit_subfzex_impl},
    {235, &emit_mullwx_impl}, {747, &emit_mullwx_impl},
    {491, &emit_divwx_impl},  {1003, &emit_divwx_impl},
    {459, &emit_divwux_impl}, {971, &emit_divwux_impl},
    {  0, &emit_cmp_impl},
    { 32, &emit_cmpl_impl},
    { 26, &emit_cntlzwx_impl},
    {922, &emit_extshx_impl},
    {954, &emit_extsbx_impl},
    {536, &emit_srwx_impl},
    {824, &emit_srawix_impl},
    { 24, &emit_slwx_impl},
    // Memory barriers — emit nothing (WASM is sequentially consistent).
    {598, &emit_nop_impl},  // sync / lwsync / ptesync
    {854, &emit_nop_impl},  // eieio
    { 86, &emit_nop_impl},  // dcbf  (no real cache to flush)
    { 54, &emit_nop_impl},  // dcbst
    {278, &emit_nop_impl},  // dcbt  (cache touch / hint)
    {246, &emit_nop_impl},  // dcbtst
    {470, &emit_nop_impl},  // dcbi  (invalidate — real cache only)
    {982, &emit_nop_impl},  // icbi  (instruction cache invalidate)
    // SPR access — direct slots only; CoreTiming/MMCR/BAT/HID0 fall back.
    {339, &emit_mfspr_impl},
    {467, &emit_mtspr_impl},
    // Time base read (TBL/TBU) — thin native import bypasses SingleStepInner.
    {371, &emit_mftb_impl},
    // CR field access (mfcr/mtcrf — currently fallback; encoding extraction
    // is non-trivial because Dolphin packs CR into 8 u64 fields, not the
    // packed 32-bit format mfcr returns. Listed explicitly so they're not
    // mistakenly considered "missing".)
    { 19, &emit_mfcr_impl},
    {144, &emit_mtcrf_impl},
    // dcbz — 32-byte zero block (memset hot path)
    {1014, &emit_dcbz_impl},
    // X-form indexed load/store — register-indexed addressing.
    // Critical for OS/library code; native path uses our permissive trampoline
    // (Memory::Read_U32 with 0x3FFFFFFF masking) instead of Dolphin's strict
    // MMU which panics on real-mode access to virtual addresses.
    { 23, &emit_lwzx_impl},
    { 55, &emit_lwzux_impl},
    {279, &emit_lhzx_impl},
    {311, &emit_lhzux_impl},
    {343, &emit_lhax_impl},
    {375, &emit_lhaux_impl},
    { 87, &emit_lbzx_impl},
    {119, &emit_lbzux_impl},
    {151, &emit_stwx_impl},
    {183, &emit_stwux_impl},
    {407, &emit_sthx_impl},
    {439, &emit_sthux_impl},
    {215, &emit_stbx_impl},
    {247, &emit_stbux_impl},
    // MSR / SR access — fallback + block_end (privileged state change).
    { 83, &emit_mfmsr_impl},
    {146, &emit_mtmsr_impl},
    {210, &emit_mtsr_impl},
    {242, &emit_mtsrin_impl},
    {306, &emit_tlbie_impl},
    {595, &emit_mfsr_impl},
    {659, &emit_mfsrin_impl},
};

// op59 sub-ops (single-precision FP arith). Dispatch via SUBOP5 (bits 26-30).
constexpr OpEntry table59_entries[] = {
    {18, &emit_fdivsx_impl},
    {20, &emit_fsubsx_impl},
    {21, &emit_faddsx_impl},
    {25, &emit_fmulsx_impl},
    {28, &emit_fmsubsx_impl},
    {29, &emit_fmaddsx_impl},
    {30, &emit_fnmsubsx_impl},
    {31, &emit_fnmaddsx_impl},
};

// op63 arith sub-ops (5-bit dispatch). 4-operand ops (fmadd-class) carry an
// rC field in bits 21-25, so we MUST mask via SUBOP5 — SUBOP10 would vary
// with rC and miss the lookup.
constexpr OpEntry table63_arith_entries[] = {
    {18, &emit_fdivx_impl},
    {20, &emit_fsubx_impl},
    {21, &emit_faddx_impl},
    {25, &emit_fmulx_impl},
    {28, &emit_fmsubx_impl},
    {29, &emit_fmaddx_impl},
};

// op63 single-purpose 10-bit sub-ops. These don't collide with the arith
// SUBOP5 keys above because their SUBOP5 values (0, 8, etc.) are unused
// in the arith table.
constexpr OpEntry table63_other_entries[] = {
    {  0, &emit_fcmpu_impl},   // FP compare unordered
    { 12, &emit_frspx_impl},   // round to single (PS0 + PS1 fill)
    { 14, &emit_fctiwx_impl},  // FP → i32 (round-to-nearest, FPSCR.RN=0 assumed)
    { 15, &emit_fctiwzx_impl}, // FP → i32 (round-toward-zero)
    { 32, &emit_fcmpu_impl},   // FP compare ordered (same impl — FPSCR diffs skipped)
    { 40, &emit_fnegx_impl},   // -rB
    { 72, &emit_fmrx_impl},    // rD = rB (move)
    {136, &emit_fnabsx_impl},  // -|rB|
    {264, &emit_fabsx_impl},   // |rB|
};

constexpr EmitFn table_lookup(const OpEntry* tbl, std::size_t n, u32 key) {
    for (std::size_t i = 0; i < n; ++i)
        if (tbl[i].op == key) return tbl[i].fn;
    return nullptr;
}

} // namespace

// ---------------------------------------------------------------------------
EmitFn gekko_lookup(u32 inst) {
    const u32 op = OPCD(inst);
    EmitFn p = table_lookup(primary_entries,
                            sizeof(primary_entries)/sizeof(primary_entries[0]),
                            op);
    if (!p) return nullptr;
    if (p == S_T4)  return table_lookup(nullptr, 0, SUBOP10(inst)); // not yet populated
    if (p == S_T19) return table_lookup(table19_entries,
                                        sizeof(table19_entries)/sizeof(table19_entries[0]),
                                        SUBOP10(inst));
    if (p == S_T31) return table_lookup(table31_entries,
                                        sizeof(table31_entries)/sizeof(table31_entries[0]),
                                        SUBOP10(inst));
    if (p == S_T59) return table_lookup(table59_entries,
                                        sizeof(table59_entries)/sizeof(table59_entries[0]),
                                        SUBOP5(inst));
    if (p == S_T63) {
        // op63: try arith table (SUBOP5) first, then 10-bit table.
        EmitFn f = table_lookup(table63_arith_entries,
                                sizeof(table63_arith_entries)/sizeof(table63_arith_entries[0]),
                                SUBOP5(inst));
        if (f) return f;
        return table_lookup(table63_other_entries,
                            sizeof(table63_other_entries)/sizeof(table63_other_entries[0]),
                            SUBOP10(inst));
    }
    return p;
}

// Per-op exception bail. Native emitters write GPRs/CR/XER but never touch
// ppc_state.pc — so if a *prior* op in this block (fallback or native)
// raised an exception that should vector PC, native ops would keep running
// with corrupted state. Fallback ops are protected by dolphin_interp's
// PC-divergence guard in JitWasm.cpp; native ops have no equivalent, so
// this bail is what catches that case. Emits:
//
//   if (ppc_check_exc(pc)) { return ppc_state.pc; }
//
// The host's dolphin_check_exc reads ppc_state.Exceptions only — it does
// NOT call CheckExceptions (the dispatcher's outer loop handles vectoring
// before re-entering the next block). Cost: one host call per native op.
//
// While gekko_emit_instr is in its all-fallback override, used_fallback is
// true on every op and this helper is dead. Becomes live once any group of
// native emitters is re-enabled.
static void emit_exception_bail(EmitCtx& c) {
    c.b.op_i32_const((s32)c.pc);
    c.b.op_call(WIMPORT_CHECK_EXC);
    emit_b11_op_if(c, WASM_TYPE_I32);
        // B11: flush WITHOUT clearing compile-time dirty[]: we're inside
        // an if-branch that returns. If the runtime takes this branch,
        // the flush ops execute. If the runtime doesn't take it, the post-
        // if code path still believes its locals are dirty (correctly).
        emit_flush_dirty_gprs_inside_branch(c, g_ctx_ptr);
        c.b.op_i32_const((s32)g_ctx_ptr);
        c.b.op_i32_load(ppc_off::PC);
        c.b.op_return();
    emit_b11_op_else(c);
        c.b.op_i32_const(0);  // dummy to satisfy if-result type
    emit_b11_op_end(c);
    c.b.op_drop();
}

void gekko_emit_instr(EmitCtx& c) {
    // Dispatch through gekko_lookup. Native emitters cover most of the
    // integer/branch/load/store/SPR space; fall back to dolphin_interp for
    // ops without a native impl (FP single/double, mfcr, mtcrf, system).
    //
    // Native ops don't touch ppc_state.pc themselves (branches overwrite
    // with target before block exit; non-branches leave pc alone). Pre-set
    // pc = c.pc before each native op — mirrors dolphin_interp's first
    // line (`ppc_state.pc = pc`). This keeps three things working:
    //   1. Block-exit dispatcher read of ppc_state.pc returns a current
    //      value, not whatever stale pc was left by the prior block entry.
    //   2. The exception bail returns the faulting instruction's pc, so
    //      the dispatcher re-enters at the correct location after the
    //      handler vectors PC.
    //   3. Chained-block continuation: when a chained block continues
    //      past a non-terminator native op, the next op's pre-set advances
    //      pc with the chain.
    c.used_fallback = false;
    EmitFn fn = gekko_lookup(c.inst);
    if (fn) {
        emit_set_pc(c, g_ctx_ptr, c.pc);
        fn(c);
    } else {
        emit_fallback(c);
    }

    // Safety net for FALLBACK paths only. Native emitters set block_end
    // themselves where appropriate (and deliberately leave it false for
    // chain_fallthrough cases — bne+ in a chain extends into its
    // fallthrough's emitter without terminating the block). If we apply
    // ends_block to the native path here, we break that chain extension:
    // the next instruction's emitter never runs, and whatever the native
    // emit's pre-op set_pc(c.pc) wrote to ppc_state.pc is what the
    // trailing read-PC-and-return picks up — pinning the dispatcher to
    // the same pc forever.
    if (c.used_fallback) {
        const u32 inst  = c.inst;
        const u32 op    = (inst >> 26) & 0x3F;
        const u32 sub10 = (inst >> 1)  & 0x3FF;
        bool ends_block = false;
        if (op == 16 || op == 17 || op == 18) ends_block = true;     // bc, sc, b
        if (op == 19) {
            if (sub10 == 16 || sub10 == 528 || sub10 == 50)
                ends_block = true;                                    // bclr, bcctr, rfi
        }
        if (op == 31) {
            if (sub10 == 146 || sub10 == 178 ||                       // mtmsr, mtmsrd
                sub10 == 210 || sub10 == 242 ||                       // mtsr, mtsrin
                sub10 == 4)                                           // tw
                ends_block = true;
        }
        if (ends_block) c.block_end = true;
    }

    // Per-op exception bail — only after a native emitter ran (fallback ops
    // are covered by their own PC-divergence guard) and only for non-
    // terminator ops (terminators exit the block anyway). Currently dead
    // because all ops route through emit_fallback above.
    if (!c.used_fallback && !c.block_end) {
        emit_exception_bail(c);
    }
}

// ---------------------------------------------------------------------------
// build_block — emit a complete WASM module that runs `count` instructions.
// Module signature:
//   () -> i32     (returns the next-PC the dispatcher should look up next)
//
// The generated code:
//   1. Iterates the instruction list at compile time.
//   2. For each, calls the matching emitter (which writes to `b`).
//   3. Stops at the first emitter that sets ctx.block_end (branches), or
//      after all instructions, in which case it falls through and returns
//      pc + count*4 (i.e. the address right after the block).
// ---------------------------------------------------------------------------

// Compile-time block-emission invariant. Scans the just-emitted bytes to
// confirm the body contains at least one PC-update mechanism — either an
// `i32.store offset=0` (set_pc, opcode 0x36 align=2 offset=0) OR a
// `return_call_indirect` (tail-call, opcode 0x13). A body lacking BOTH
// can never advance ppc_state.pc beyond what the dispatcher passed in,
// which guarantees a dispatch-loop self-loop. Catches the entire bug class
// where an emitter forgets to terminate a block properly (the bne+
// chain_fallthrough safety-net override regression that pinned pc=
// 0x800e52fc would have shown up here if the body had been truly empty).
//
// This check is dynamic-cost only at compile time, not at dispatch time —
// each block compiles once. ~30-byte scan per compile, no measurable
// impact even during region re-link.
static void verify_block_can_advance_pc(const std::vector<u8>& body, u32 start_pc) {
    bool has_pc_store = false;
    bool has_tail_call = false;
    for (size_t i = 0; i + 2 < body.size(); ++i) {
        // i32.store align=2 offset=0  →  0x36 0x02 0x00
        if (body[i] == 0x36 && body[i+1] == 0x02 && body[i+2] == 0x00) {
            has_pc_store = true;
        }
        // return_call_indirect  →  0x13 (followed by typeidx + tableidx LEBs)
        if (body[i] == 0x13) {
            has_tail_call = true;
        }
        if (has_pc_store && has_tail_call) break;
    }
    if (!has_pc_store && !has_tail_call) {
#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.error('[bemental] block-invariant FAIL: pc=0x'
                + ($0>>>0).toString(16) + ' body has no PC write and no '
                + 'tail call (body_size=' + $1 + ') — this block will '
                + 'self-loop on dispatch');
        }, start_pc, (int)body.size());
#endif
    }
}

// Self-loop detection. Scans the stream for a CTR-bounded conditional
// branch (op 16 with BO=bdnz/bdz, no-AA, no-LK) whose target lies WITHIN
// this block. Returns the FIRST match found (closest to start) so
// post-loop instructions can be inlined.
//
// On success, sets:
//   *out_bdnz_idx        index of the self-loop bcx in insts[]
//   *out_loop_entry_idx  index of the back-branch target in insts[]
//
// **Only bdnz/bdz are accepted.** CR-branches (bne+/beq+/bgt+/etc.)
// are rejected because they may be MMIO-polling loops that deadlock if
// wrapped in WASM `loop` — the dispatcher never gets control to fire
// CoreTiming events the loop is waiting on. CTR-bounded loops can't
// deadlock (CTR self-terminates after N iters regardless of side state).
static bool detect_self_loop(const u32* insts, u32 count,
                             const u32* instr_pcs, u32 start_pc,
                             u32* out_bdnz_idx,
                             u32* out_loop_entry_idx) {
    if (count < 2) return false;
    for (u32 i = 0; i < count; ++i) {
        const u32 inst = insts[i];
        const u32 op = (inst >> 26) & 0x3F;
        if (op != 16) continue;             // not bcx
        if ((inst & 0x3) != 0) continue;     // AA or LK set — skip
        s32 bd = static_cast<s32>(inst & 0xFFFC);
        if (bd & 0x8000) bd |= 0xFFFF0000;   // sign-extend 16-bit
        const u32 cur_pc = instr_pcs ? instr_pcs[i]
                                     : (start_pc + i * 4u);
        const u32 target = static_cast<u32>(static_cast<s32>(cur_pc) + bd);
        if (target < start_pc) continue;
        const u32 byte_off = target - start_pc;
        if ((byte_off & 0x3u) != 0u) continue;
        const u32 entry_idx = byte_off / 4u;
        if (entry_idx > i) continue;         // target ahead → forward branch (not a loop)
        if (instr_pcs && instr_pcs[entry_idx] != target) continue;
        const u32 bo = (inst >> 21) & 0x1Fu;
        const bool is_bdnz = (bo == 0b10000u);
        const bool is_bdz  = (bo == 0b10010u);
        // CR-branches deliberately rejected: see header comment about
        // MMIO-poll deadlock.
        if (!is_bdnz && !is_bdz) continue;
        if (out_bdnz_idx)        *out_bdnz_idx        = i;
        if (out_loop_entry_idx)  *out_loop_entry_idx  = entry_idx;
        return true;
    }
    return false;
}

// Emit the WASM control-flow predicate for the self-loop's terminating
// branch: `br_if 0` continues the loop, fall-through exits. The CR-test
// path mirrors emit_bcx_impl's CR-bit decode but emits br_if 0 instead of
// emit_branch_resolution. The BO encodes which of (bdnz/bdz/cr_branch).
static void emit_self_loop_terminator(EmitCtx& c, u32 inst) {
    const u32 bo = BO(inst), bi = BI(inst);
    const bool is_bdnz = (bo == 0b10000u);
    const bool is_bdz  = (bo == 0b10010u);

    if (is_bdnz || is_bdz) {
        // Decrement CTR; test against 0; br_if 0 if predicate true.
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::spr(9));
        c.b.op_i32_const(1);
        c.b.op_i32_sub();
        c.b.op_local_tee(LOCAL_TMP_A);
        c.b.op_i32_store(ppc_off::spr(9));
        c.b.op_local_get(LOCAL_TMP_A);
        c.b.op_i32_const(0);
        if (is_bdnz) c.b.op_i32_ne(); else c.b.op_i32_eq();
        c.b.op_br_if(0);
        return;
    }
    // CR-test branch (BO = 0bX01XX). bit 3 of BO == 1 => branch on true.
    const bool branch_if_true = (bo & 0b01000u) != 0u;
    const u32 field_idx = bi / 4u;
    const u32 bit_in_field = bi % 4u;       // 0=LT, 1=GT, 2=EQ, 3=SO
    switch (bit_in_field) {
      case 0:   // LT — bit 30 of cr_field high u32
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx) + 4);
        c.b.op_i32_const(1u << 30);
        c.b.op_i32_and();
        c.b.op_i32_const(0);
        c.b.op_i32_ne();
        break;
      case 1:   // GT — NOT(LT) AND NOT(EQ)
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx) + 4);     // high
        c.b.op_i32_const(1u << 30);
        c.b.op_i32_and();
        c.b.op_i32_eqz();                                       // NOT LT
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx));         // low
        c.b.op_i32_const(0);
        c.b.op_i32_ne();                                        // NOT EQ
        c.b.op_i32_and();                                       // (NOT LT) AND (NOT EQ)
        break;
      case 2:   // EQ — low u32 == 0
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx));
        c.b.op_i32_eqz();
        break;
      case 3:   // SO — bit 27 of high u32
        c.b.op_i32_const((s32)CTX);
        c.b.op_i32_load(ppc_off::cr_field(field_idx) + 4);
        c.b.op_i32_const(1u << 27);
        c.b.op_i32_and();
        c.b.op_i32_const(0);
        c.b.op_i32_ne();
        break;
    }
    if (!branch_if_true) {
        c.b.op_i32_eqz();
    }
    c.b.op_br_if(0);
}

// Internal body emitter shared by build_block (legacy single-function
// module) and emit_block_body (multi-module accumulator path). Emits the
// per-block DFA + locals + HLE prologue + instruction stream + trailing
// PC-read + return, all between the supplied builder's beginFuncBody()
// and endFuncBody() (which the CALLER is responsible for invoking).
//
// All branch emitters consult `lookup_fn`/`lookup_user` (when non-null)
// to resolve same-region branch targets to local fn indices. When null,
// every branch host-bounces (legacy behavior).
// Merged-mode parameters bundle (avoids growing the signature for legacy
// callers). When `merged` is true, emit_body_into:
//   - SKIPS the per-body emitLocals call (caller declared 35 locals at the
//     enclosing function level, shared across all PPC blocks in the region)
//   - propagates `br_to_loop_depth` and `entry_sel_global_idx` into the
//     EmitCtx so emit_branch_resolution emits the merged-fast-path branch.
struct MergedModeArgs {
    bool merged              = false;
    u32  br_to_loop_depth    = 0;
    u32  entry_sel_global_idx = 0;
};

static void emit_body_into(WasmModuleBuilder& b,
                           u32 start_pc, const u32* insts, u32 count,
                           u32 ctx_ptr_const,
                           u32 mem1_base, u32 mem1_mask, u32 ram_size,
                           const u32* instr_pcs,
                           LocalIdxLookupFn lookup_fn,
                           const void* lookup_user,
                           bool emit_hle_check_prologue,
                           const MergedModeArgs& merged = {}) {
    g_ctx_ptr = ctx_ptr_const;
    // Per-block DFA: walk the block's instructions, track which GPRs are
    // "trusted" as MEM1 pointers. Trusted baselines: r1 (stack), r2 (TOC),
    // r13 (SDA). Trust propagates through addi/addis/lis from a trusted
    // source. Loads invalidate their dest; any other write to dest
    // invalidates. If ALL D-form load/store base registers are trusted at
    // their use, the block is safe for MEM1 fastpath
    // (g_mem1_base = mem1_base). Otherwise force trampoline path
    // (g_mem1_base = 0). Compile-time decision keeps Liftoff straight-line
    // for both fast and slow blocks — no per-load runtime branch.
    {
        u32 trust = (1u << 1) | (1u << 2) | (1u << 13);
        bool block_safe = true;
        for (u32 i = 0; i < count; ++i) {
            const u32 inst = insts[i];
            const u32 op = (inst >> 26) & 0x3Fu;
            const u32 rt = (inst >> 21) & 0x1Fu;
            const u32 ra = (inst >> 16) & 0x1Fu;
            if (op >= 32u && op <= 45u) {
                const bool base_trusted = (ra == 0u) || ((trust & (1u << ra)) != 0u);
                if (!base_trusted) { block_safe = false; break; }
            }
            if (op == 14u) {
                if (rt != 0u) {
                    if (ra == 0u || (trust & (1u << ra))) trust |= (1u << rt);
                    else trust &= ~(1u << rt);
                }
            } else if (op == 15u) {
                if (rt != 0u) {
                    const u32 imm = inst & 0xFFFFu;
                    if (ra == 0u) {
                        const bool mem1 = (imm >= 0x8000u && imm <= 0x817Fu)
                                       || (imm < 0x0180u);
                        if (mem1) trust |= (1u << rt);
                        else trust &= ~(1u << rt);
                    } else {
                        trust &= ~(1u << rt);
                    }
                }
            } else if (op == 32u || op == 34u || op == 40u || op == 42u) {
                if (rt != 0u) trust &= ~(1u << rt);
            } else if (op == 33u || op == 35u || op == 41u || op == 43u) {
                if (rt != 0u) trust &= ~(1u << rt);
            } else if (op == 31u) {
                if (rt != 0u) trust &= ~(1u << rt);
            } else if (op >= 24u && op <= 29u) {
                if (ra != 0u) trust &= ~(1u << ra);
            }
        }
        // Keep g_mem1_base populated regardless of trust DFA result —
        // emit_load_d / emit_store_d use g_mem1_safe to choose between
        // compile-time-direct and runtime-check fastmem paths. Setting
        // g_mem1_base to 0 only when the caller didn't provide one.
        g_mem1_base = mem1_base;
        g_mem1_safe = block_safe;
    }
    g_mem1_mask = mem1_mask;
    g_ram_size  = ram_size;

    // Locals: 2 i32 scratch + 1 f64 scratch + 32 i32 GPR cache (B11).
    // GPR locals start at index GPR_LOCAL_BASE = 3 (after the f64). They
    // are always declared so emit_body_into's local layout is stable;
    // V8 elides the unused ones when use_gpr_locals is false.
    //
    // Merged-mode skip: in build_region_function the same 35 locals are
    // declared once at the function level (shared across all per-block
    // regions of the body). Re-emitting them per body would double the
    // local count and shift indices.
    if (!merged.merged) {
        const u32 counts[] = { LOCAL_TMP_COUNT, 1, 32u };
        const u8  types[]  = { WASM_TYPE_I32,    WASM_TYPE_F64, WASM_TYPE_I32 };
        b.emitLocals(3, counts, types);
    }

    EmitCtx ctx{ b, start_pc, 0u, start_pc, false, false };
    ctx.lookup_local_idx       = lookup_fn;
    ctx.lookup_user            = lookup_user;
    ctx.merged_mode            = merged.merged;
    ctx.br_to_loop_depth       = merged.br_to_loop_depth;
    ctx.entry_sel_global_idx   = merged.entry_sel_global_idx;
    // Phase 3 — flip the B11 GPR-local cache on. Inside if/else (when
    // ctx.if_depth>0) the helpers fall back to direct memory access, so
    // partially-loaded locals can't escape the merge point. After every
    // op_end (via emit_b11_op_end) the cache is invalidated.
    //
    // Direct A/B-compared at 240s wall (probe_phase3_b vs probe_phase3_off):
    // both reached iter=9M sim_time=140M with frames=5. B11 ON is
    // correctness-neutral at the current measurement scale — no regression,
    // no measurable speedup. The flag is left ON so the infrastructure is
    // active for future optimizations (cross-block GPR passing via
    // tail-call params, register-allocator over locals, etc.) where the
    // cache becomes essential.
    extern bool g_disable_b11;
    ctx.use_gpr_locals = !g_disable_b11;

    // HLE function-hooking check at the very start of every block.
    // Skipped when caller has pre-verified that no HLE hook matches
    // start_pc — saves one JS round-trip per block dispatch on the
    // ~95% of PCs that aren't HLE-patched.
    if (emit_hle_check_prologue) {
        b.op_i32_const((s32)start_pc);
        b.op_call(WIMPORT_HLE_CHECK);
        emit_local_op_if(ctx, WASM_TYPE_I32);
            b.op_i32_const((s32)ctx_ptr_const);
            b.op_i32_load(ppc_off::PC);
            b.op_return();
        b.op_else();
            b.op_i32_const(0);
        emit_local_op_end(ctx);
        b.op_drop();
    }

    // Self-loop fast path: detect "block ends with bdnz/bdz/bne/beq back
    // to start_pc" and wrap the body in WASM `loop` + `br_if 0` so the
    // entire iter chain runs inside ONE function call. Eliminates the
    // per-iter dispatch round-trip that caps T1b/T1c/T1e at 0.7-4% native.
    //
    // B11 GPR cache CAN be active inside the loop provided we flush dirty
    // locals BEFORE the back-edge `br_if 0`. The compiler emits the first
    // read of each gpr_i in the body as "memory load + tee local" because
    // `gpr_loaded[i]==false` at start of body. Subsequent reads in the
    // same iter use `local.get`. At end of iter we flush dirty locals to
    // memory; on the next iter's re-entry, memory is current, so the
    // first re-emitted "memory load + tee" sees the right value. This
    // preserves B11's intra-iter savings (multiple reads of same gpr →
    // one memory load) while staying correct across the back-edge.
    bool emitted_terminator = false;
    u32 self_loop_bdnz_idx  = 0;
    u32 self_loop_entry_idx = 0;
    if (count >= 2 && detect_self_loop(insts, count, instr_pcs, start_pc,
                                       &self_loop_bdnz_idx,
                                       &self_loop_entry_idx)) {
        // Emit setup instructions [0, entry_idx) as straight-line.
        for (u32 i = 0; i < self_loop_entry_idx; ++i) {
            ctx.pc = instr_pcs ? instr_pcs[i] : (start_pc + i * 4u);
            ctx.inst = insts[i];
            ctx.block_end = false;
            ctx.chain_fallthrough = false;
            gekko_emit_instr(ctx);
            if (ctx.block_end) {
                emitted_terminator = true;
                break;
            }
        }
        if (!emitted_terminator) {
            // Flush before entering the loop so the loop body's first
            // memory loads see consistent state.
            emit_flush_dirty_gprs_impl(ctx, g_ctx_ptr);
            // Loop body: instructions [entry_idx, bdnz_idx) wrapped in
            // `loop` + `br_if 0`.
            emit_local_op_loop(ctx, 0x40);
                for (u32 i = self_loop_entry_idx; i < self_loop_bdnz_idx; ++i) {
                    ctx.pc = instr_pcs ? instr_pcs[i] : (start_pc + i * 4u);
                    ctx.inst = insts[i];
                    ctx.block_end = false;
                    ctx.chain_fallthrough = false;
                    gekko_emit_instr(ctx);
                    if (ctx.block_end) break;
                }
                // Flush dirty GPR locals BEFORE the back-edge so memory is
                // current when the next iter's first emit-time-memory-read
                // executes.
                emit_flush_dirty_gprs_impl(ctx, g_ctx_ptr);
                ctx.pc = instr_pcs ? instr_pcs[self_loop_bdnz_idx]
                                   : (start_pc + self_loop_bdnz_idx * 4u);
                ctx.inst = insts[self_loop_bdnz_idx];
                emit_self_loop_terminator(ctx, ctx.inst);
            emit_local_op_end(ctx);  // close loop
            // Emit post-loop instructions [bdnz_idx+1, count). These run
            // when the bdnz fall-through path exits the loop. Each may be
            // a hard terminator (blr, b, sc) which sets ctx.block_end and
            // emits its own set_pc + return.
            for (u32 i = self_loop_bdnz_idx + 1; i < count; ++i) {
                ctx.pc = instr_pcs ? instr_pcs[i] : (start_pc + i * 4u);
                ctx.inst = insts[i];
                ctx.block_end = false;
                ctx.chain_fallthrough = false;
                gekko_emit_instr(ctx);
                if (ctx.block_end) {
                    emitted_terminator = true;
                    break;
                }
            }
            // If post-loop ran out without a terminator, set_pc to the
            // PC after the last instruction so the dispatcher continues
            // correctly.
            if (!emitted_terminator) {
                const u32 last_pc = instr_pcs
                    ? instr_pcs[count - 1]
                    : (start_pc + (count - 1) * 4u);
                emit_set_pc(ctx, g_ctx_ptr, last_pc + 4u);
                emitted_terminator = true;
            }
        }
    } else {
    for (u32 i = 0; i < count; ++i) {
        ctx.pc = instr_pcs ? instr_pcs[i] : (start_pc + i * 4u);
        ctx.inst = insts[i];
        ctx.block_end = false;
        ctx.chain_fallthrough = false;

        if (instr_pcs && i + 1 < count) {
            const u32 op = (ctx.inst >> 26) & 0x3F;
            // Unconditional `b` whose target IS the next chained
            // instruction — drop the branch entirely.
            if (op == 18 && (ctx.inst & 0x1) == 0) {
                s32 disp = static_cast<s32>(ctx.inst & 0x03FFFFFC);
                if (disp & 0x02000000) disp |= 0xFC000000;
                const bool aa = (ctx.inst & 0x2) != 0;
                const u32 target = aa
                    ? static_cast<u32>(disp)
                    : static_cast<u32>(static_cast<s32>(ctx.pc) + disp);
                if (target == instr_pcs[i + 1])
                    continue;
            }
            // Conditional `bc` whose fall-through (pc + 4) IS the next
            // chained instruction — emit taken-only return, continue chain.
            if (op == 16 && (ctx.inst & 0x1) == 0) {
                if ((ctx.pc + 4u) == instr_pcs[i + 1])
                    ctx.chain_fallthrough = true;
            }
        }

        gekko_emit_instr(ctx);

        if (ctx.block_end) {
            emitted_terminator = true;
            break;
        }
    }
    }  // !self_loop

    // Block exit fallthrough PC.
    const u32 last_pc = instr_pcs && count > 0
                        ? instr_pcs[count - 1]
                        : (start_pc + (count - 1) * 4u);
    const u32 next_pc = last_pc + 4u;
    if (!emitted_terminator)
        emit_set_pc(ctx, g_ctx_ptr, next_pc);
    // B11: flush dirty GPR locals before exiting the block. The trailing
    // return is reachable only when no terminator (branch/blr/etc.) was
    // emitted; those paths already flushed via emit_block_exit_flush.
    // For terminator-emitting paths, this code is unreachable and the
    // flush here is dead — but harmless (V8 elides unreachable ops).
    emit_flush_dirty_gprs_impl(ctx, g_ctx_ptr);
    // Trailing return: read PC back from context. For terminators that
    // already op_return'd, this trails as unreachable code — but WASM
    // validation still requires an i32 on the (polymorphic) stack at the
    // function's `end`. For fallback-only terminators (bclr/bcctr/rfi/sc,
    // bcx-fallback), emit_fallback hands control to the interpreter which
    // writes the real branch target into ppc_state.pc. Reading PC back
    // here is what carries that target out to the dispatcher.
    b.op_i32_const((s32)g_ctx_ptr);
    b.op_i32_load(ppc_off::PC);
    b.op_return();
}

std::vector<u8> build_block(u32 start_pc, const u32* insts, u32 count,
                            u32 ctx_ptr_const, u32 mem_pages,
                            u32 mem1_base, u32 mem1_mask, u32 ram_size,
                            const u32* instr_pcs,
                            bool emit_hle_check) {
    bemental::perf_runtime::inc(bemental::PERF_SLOT_BLOCK_EMIT);
    WasmModuleBuilder b;
    b.emitHeader();

    // ---- Type section: 4 types ----
    //  type 0: () -> i32                    — block "run" function
    //  type 1: (i32) -> i32                 — read8/read16/read32
    //  type 2: (i32, i32) -> ()             — write8/write16/write32
    //  type 3: (i32, i32) -> ()             — interp(inst, pc), break_block(pc)
    //  (check_exc reuses type 1)
    b.emitTypeSection(4);
    {
        const u8 i32t[] = { WASM_TYPE_I32 };
        // type 0: () -> i32
        b.emitFuncType(nullptr, 0, i32t, 1);
        // type 1: (i32) -> i32
        b.emitFuncType(i32t, 1, i32t, 1);
        // type 2: (i32, i32) -> ()
        const u8 i32x2[] = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitFuncType(i32x2, 2, nullptr, 0);
        // type 3: (i32, i32) -> i32   (currently unused; reserved for future)
        b.emitFuncType(i32x2, 2, i32t, 1);
    }
    b.endSection();

    // ---- Import section: memory + WIMPORT_COUNT host functions ----
    b.emitImportSection(1 + WIMPORT_COUNT);
    if (mem_pages > 0) {
        b.emitImportMemory("env", "memory", mem_pages);
    } else {
        // Even with mem_pages=0 we declare the import so calls into host
        // memory resolve. Caller is responsible for binding "env.memory".
        b.emitImportMemory("env", "memory", 1);
    }
    b.emitImportFunc("env", "ppc_read8",       /*type*/1);
    b.emitImportFunc("env", "ppc_read16",      /*type*/1);
    b.emitImportFunc("env", "ppc_read32",      /*type*/1);
    b.emitImportFunc("env", "ppc_write8",      /*type*/2);
    b.emitImportFunc("env", "ppc_write16",     /*type*/2);
    b.emitImportFunc("env", "ppc_write32",     /*type*/2);
    b.emitImportFunc("env", "ppc_interp",      /*type*/2);
    b.emitImportFunc("env", "ppc_check_exc",   /*type*/1);
    b.emitImportFunc("env", "ppc_break_block", /*type*/2);
    b.emitImportFunc("env", "ppc_hle_check",   /*type*/1);  // (pc) -> i32
    // A5: ppc_read_tb dropped — mftb is direct from spr[].
    b.endSection();

    // ---- Function section: 1 function of type 0 ----
    {
        const u32 idx[] = {0};
        b.emitFunctionSection(1, idx);
    }

    // ---- Export section: "run" → func index = WIMPORT_COUNT (after imports) ----
    b.emitExportSection("run", WIMPORT_COUNT);

    // ---- Code section ----
    b.beginCodeSection(1);
    b.beginFuncBody();
    emit_body_into(b, start_pc, insts, count, ctx_ptr_const,
                   mem1_base, mem1_mask, ram_size, instr_pcs,
                   /*lookup_fn=*/nullptr, /*lookup_user=*/nullptr,
                   emit_hle_check);
    b.endFuncBody();
    b.endSection();

    auto bytes = b.getBytes();
    verify_block_can_advance_pc(bytes, start_pc);
    return bytes;
}

// ---------------------------------------------------------------------------
// emit_block_body — body-only counterpart to build_block. Same DFA + emit
// logic, but produces a single function-entry (5-byte LEB size + locals +
// ops + 0x0B) rather than a complete module. Output bytes feed directly
// into BlockCache::region_accumulate.
// ---------------------------------------------------------------------------
std::vector<u8> emit_block_body(u32 start_pc, const u32* insts, u32 count,
                                u32 ctx_ptr_const,
                                u32 mem1_base, u32 mem1_mask, u32 ram_size,
                                const u32* instr_pcs,
                                LocalIdxLookupFn lookup_fn,
                                const void* lookup_user,
                                bool emit_hle_check) {
    WasmModuleBuilder b;
    b.beginFuncBody();
    emit_body_into(b, start_pc, insts, count, ctx_ptr_const,
                   mem1_base, mem1_mask, ram_size, instr_pcs,
                   lookup_fn, lookup_user, emit_hle_check);
    b.endFuncBody();
    auto bytes = b.getBytes();
    verify_block_can_advance_pc(bytes, start_pc);
    return bytes;
}

// ---------------------------------------------------------------------------
// build_region_module — wrap N pre-emitted function bodies into a single
// merged WASM module with an INTERNAL funcref table populated via active
// element segment. Each body is exported as `fn_<i>` for JS-side dispatch.
//
// V8 inlining invariant: the table is internally declared (table section),
// not imported. Bodies that emit `call_indirect (table 0, type 0)` for
// intra-region branch targets land on the same instance's table — V8's
// speculative inliner only inlines call_indirect when caller and callee
// share an instance. Importing the table would defeat the entire refactor.
//
// Section order (per WASM spec): type, import, function, table, export,
// element, code.
// ---------------------------------------------------------------------------
std::vector<u8> build_region_module(const u8* concatenated_bodies,
                                    std::size_t concatenated_size,
                                    u32 n_funcs,
                                    u32 mem_pages) {
    if (n_funcs == 0u || concatenated_bodies == nullptr || concatenated_size == 0u)
        return {};

    WasmModuleBuilder b;
    b.emitHeader();

    // ---- Type section: same 4 types as build_block ----
    //  type 0: () -> i32
    //  type 1: (i32) -> i32
    //  type 2: (i32, i32) -> ()
    //  type 3: (i32, i32) -> i32  (reserved)
    b.emitTypeSection(4);
    {
        const u8 i32t[]  = { WASM_TYPE_I32 };
        const u8 i32x2[] = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitFuncType(nullptr, 0, i32t, 1);
        b.emitFuncType(i32t, 1, i32t, 1);
        b.emitFuncType(i32x2, 2, nullptr, 0);
        b.emitFuncType(i32x2, 2, i32t, 1);
    }
    b.endSection();

    // ---- Import section: memory + WIMPORT_COUNT host functions ----
    b.emitImportSection(1u + (u32)WIMPORT_COUNT);
    b.emitImportMemory("env", "memory", mem_pages > 0u ? mem_pages : 1u);
    b.emitImportFunc("env", "ppc_read8",       /*type*/1);
    b.emitImportFunc("env", "ppc_read16",      /*type*/1);
    b.emitImportFunc("env", "ppc_read32",      /*type*/1);
    b.emitImportFunc("env", "ppc_write8",      /*type*/2);
    b.emitImportFunc("env", "ppc_write16",     /*type*/2);
    b.emitImportFunc("env", "ppc_write32",     /*type*/2);
    b.emitImportFunc("env", "ppc_interp",      /*type*/2);
    b.emitImportFunc("env", "ppc_check_exc",   /*type*/1);
    b.emitImportFunc("env", "ppc_break_block", /*type*/2);
    b.emitImportFunc("env", "ppc_hle_check",   /*type*/1);
    // A5: ppc_read_tb dropped — mftb is direct from spr[].
    b.endSection();

    // ---- Function section: N entries, all type 0 ((), i32) ----
    {
        std::vector<u32> typeIndices(n_funcs, 0u);
        b.emitFunctionSection(n_funcs, typeIndices.data());
    }

    // ---- Table section: one INTERNAL funcref table of size n_funcs.
    // Both initial and max set to n_funcs — the merged module is sealed
    // at instantiate time; growth is impossible (next re-link replaces
    // the whole module). ----
    b.beginTableSection(1);
    b.emitTable(n_funcs, /*hasMax=*/true, n_funcs, WASM_REF_FUNCREF);
    b.endSection();

    // ---- Export section: each body as fn_<i>. WASM function indices
    // for declared functions start at WIMPORT_COUNT (since 10 imports
    // claim indices 0..9). ----
    b.beginExportSection(n_funcs);
    {
        char name[24];
        for (u32 i = 0; i < n_funcs; ++i) {
            std::snprintf(name, sizeof(name), "fn_%u", (unsigned)i);
            b.emitExport(name, WASM_EXPORT_FUNC, (u32)WIMPORT_COUNT + i);
        }
    }
    b.endSection();

    // ---- Element section: 1 active segment populating table 0 from
    // offset 0 with [WIMPORT_COUNT, WIMPORT_COUNT+1, ..., WIMPORT_COUNT+N-1]. ----
    b.beginElementSection(1);
    {
        std::vector<u32> indices(n_funcs);
        for (u32 i = 0; i < n_funcs; ++i) indices[i] = (u32)WIMPORT_COUNT + i;
        b.emitActiveElementSegment(/*offset=*/0u, indices.data(), n_funcs);
    }
    b.endSection();

    // ---- Code section: N body entries, copied verbatim from the
    // accumulator. Each entry is already in code-section format
    // (5-byte LEB128 size prefix + locals + ops + 0x0B end). ----
    b.beginCodeSection(n_funcs);
    b.emitBytes(concatenated_bodies, concatenated_size);
    b.endSection();

    return b.getBytes();
}

// ---------------------------------------------------------------------------
// Lever #2 — single-function merged-region build. Emits ONE WASM module
// whose code section contains a single function `region` taking no params
// and returning i32 (next_pc). Inside it: 35 shared locals (2 i32 scratch +
// 1 f64 scratch + 32 i32 GPR cache), then a `loop $L` containing N nested
// `block`s and a `br_table` keyed on the mutable WASM global `entry_sel`.
//
// Block K's emitted body lives between `end $b_K` and `end $b_{K+1}`
// (block N-1's body lives between `end $b_N-1` and `end loop $L`). Every
// block must terminate explicitly — fall-through into the next block would
// execute a wrong-PC body since adjacent blocks may have non-contiguous
// PCs in PowerPC space.
// ---------------------------------------------------------------------------
namespace {
// Local lookup wrapper: build_region_function's caller passes a generic
// LocalIdxLookupFn (receiving target_pc → out_local_idx). Internally we
// pre-compute a pc → local-idx map for this region, then expose the same
// callback shape to emit_body_into so emit_branch_resolution emits the
// merged-fast-path branch (`global.set entry_sel; br $L`).
struct RegionFnCtx {
    LocalIdxLookupFn user_fn;
    const void*      user_user;
};
static bool region_fn_lookup(const void* user, u32 target_pc, u32* out) {
    auto* c = (const RegionFnCtx*)user;
    if (!c->user_fn) return false;
    return c->user_fn(c->user_user, target_pc, out);
}
}  // namespace

std::vector<u8> build_region_function(const BlockInputs* blocks,
                                      u32 n_blocks,
                                      LocalIdxLookupFn lookup_fn,
                                      const void* lookup_user,
                                      u32 mem_pages) {
    if (blocks == nullptr || n_blocks == 0u) return {};

    WasmModuleBuilder b;
    b.emitHeader();

    // ---- Type section: same 4 types as build_block ----
    //   type 0: () -> i32                — region function signature
    //   type 1: (i32) -> i32             — read*, check_exc, hle_check, read_tb
    //   type 2: (i32, i32) -> ()         — write*, interp, break_block
    //   type 3: (i32, i32) -> i32        — reserved
    b.emitTypeSection(4);
    {
        const u8 i32t[]  = { WASM_TYPE_I32 };
        const u8 i32x2[] = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitFuncType(nullptr, 0, i32t, 1);
        b.emitFuncType(i32t, 1, i32t, 1);
        b.emitFuncType(i32x2, 2, nullptr, 0);
        b.emitFuncType(i32x2, 2, i32t, 1);
    }
    b.endSection();

    // ---- Import section: env.memory + WIMPORT_COUNT host functions ----
    b.emitImportSection(1u + (u32)WIMPORT_COUNT);
    b.emitImportMemory("env", "memory", mem_pages > 0u ? mem_pages : 1u);
    b.emitImportFunc("env", "ppc_read8",       /*type*/1);
    b.emitImportFunc("env", "ppc_read16",      /*type*/1);
    b.emitImportFunc("env", "ppc_read32",      /*type*/1);
    b.emitImportFunc("env", "ppc_write8",      /*type*/2);
    b.emitImportFunc("env", "ppc_write16",     /*type*/2);
    b.emitImportFunc("env", "ppc_write32",     /*type*/2);
    b.emitImportFunc("env", "ppc_interp",      /*type*/2);
    b.emitImportFunc("env", "ppc_check_exc",   /*type*/1);
    b.emitImportFunc("env", "ppc_break_block", /*type*/2);
    b.emitImportFunc("env", "ppc_hle_check",   /*type*/1);
    // A5: ppc_read_tb dropped — mftb is direct from spr[].
    b.endSection();

    // ---- Function section: 1 region function of type 0 ----
    {
        const u32 idx[] = {0u};
        b.emitFunctionSection(1u, idx);
    }

    // ---- Global section: 1 mutable i32 = entry_sel, init 0 ----
    b.beginGlobalSection(1u);
    b.emitGlobalI32Mut(0);
    b.endSection();

    // ---- Export section: "region" (func) + "entry_sel" (global) ----
    b.beginExportSection(2u);
    b.emitExport("region",    WASM_EXPORT_FUNC,   (u32)WIMPORT_COUNT);
    b.emitExport("entry_sel", WASM_EXPORT_GLOBAL, 0u);
    b.endSection();

    // ---- Code section: 1 function body ----
    b.beginCodeSection(1u);
    b.beginFuncBody();

    // Locals: 2 i32 scratch + 1 f64 scratch + 32 i32 GPR cache (B11).
    // Declared ONCE at function level — all per-block emits share them.
    {
        const u32 counts[] = { LOCAL_TMP_COUNT, 1u, 32u };
        const u8  types[]  = { WASM_TYPE_I32,    WASM_TYPE_F64, WASM_TYPE_I32 };
        b.emitLocals(3u, counts, types);
    }

    // Open the outer loop $L.
    b.op_loop(0x40);

    // Open N nested blocks $b_{N-1} (outermost) ... $b_0 (innermost).
    for (u32 i = 0; i < n_blocks; ++i) {
        b.op_block(0x40);
    }

    // br_table dispatch — innermost, depth 0 = $b_0, ..., depth N-1 = $b_{N-1},
    // depth N = $L. Default = 0 (silent fall to block 0 if sel out of range;
    // dispatcher is responsible for passing sel ∈ [0, N)).
    b.op_global_get(/*entry_sel*/0u);
    {
        std::vector<u32> arms(n_blocks);
        for (u32 i = 0; i < n_blocks; ++i) arms[i] = i;
        b.op_br_table(arms.data(), n_blocks, /*default=*/0u);
    }

    // Close $b_0 (innermost), then emit block 0's body.
    // Then close $b_1, emit block 1's body. Repeat through block N-1.
    RegionFnCtx ctx{ lookup_fn, lookup_user };
    for (u32 i = 0; i < n_blocks; ++i) {
        // Close the (N-i)-th nested block — landing point for sel == i.
        b.op_end();
        // Emit block i's body. br_to_loop_depth = N - 1 - i.
        const BlockInputs& bi = blocks[i];
        MergedModeArgs m;
        m.merged              = true;
        m.br_to_loop_depth    = (n_blocks - 1u) - i;
        m.entry_sel_global_idx = 0u;
        emit_body_into(b,
                       bi.start_pc, bi.insts, bi.count,
                       bi.ctx_ptr_const,
                       bi.mem1_base, bi.mem1_mask, bi.ram_size,
                       bi.instr_pcs,
                       &region_fn_lookup, &ctx,
                       bi.emit_hle_check,
                       m);
        // emit_body_into ends with: `i32.load PC` `return`. That `return`
        // exits the whole region function, leaving the loop semantics
        // intact for sibling blocks. After the trailing return, control
        // can never reach the next `op_end` from this body — so the next
        // body's prologue is dead-code from the WASM validator's view,
        // but the validator handles polymorphic stack after `return`.
    }

    // Close the outer loop $L.
    b.op_end();

    // Trailing unreachable so the function has a valid type at end (the
    // loop never falls through normally — every body terminates with
    // `return` or `br $L`).
    b.emitByte(wop::unreachable);

    b.endFuncBody();
    b.endSection();

    return b.getBytes();
}

} // namespace bemental::powerpc
