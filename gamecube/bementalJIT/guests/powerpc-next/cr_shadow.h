#pragma once
//
// [PM56 lazy-CR / deferred flags] Shadow representation for the QEMU-cc_op-style
// lazy condition-register model. A compare/record op stores its OPERANDS + an
// op-kind tag here (cheap) instead of building the ~30-op eager CR-field u64;
// consumers MATERIALIZE the bit(s) they need on demand. Sound cross-block by
// construction — the deferred form is complete and self-contained; no liveness,
// no guard (see memory gc_jit_lazy_cr_flags_architecture_2026_08_04).
//
// Representation B (shadow + pending): PowerPCState.cr[] stays eager-at-rest
// (all host/interp readers unchanged); this shadow + a per-field pending flag
// live in bementalJIT globals, addressed from emitted wasm by absolute host
// address (the g_bem_disp_tag pattern). A field is "pending" iff its live value
// is in the shadow and cr[] is stale. Every path that makes cr[] host-visible
// (the dolphin_interp funnel; savestate) must materialize pending fields first.
//
// SO is FROZEN at produce time (so byte) — PowerPC copies XER.SO into CR at the
// compare, so an intervening mtxer/mcrxr must NOT leak into a later materialize.

#include <cstdint>

namespace bemental::powerpc {

// [PM56 lazy-CR] Master gate. OFF = byte-identical to the pre-PM56 eager CR
// (producers build the eager field; emit_crbit_test reads it with no pending
// check). MEASURED VERDICT 2026-08-04: the full deferred pair (Stage 1 cmp +
// Stage 6a Rc) is SOUND (test_diff_next 3457/0, cross-block + SO-freeze tests
// pass, oracle-validated reconstruction) but a consistent ~4% SAB regression:
// after every producer defers, each conditional branch takes the heavier
// runtime materialize path (pending-check + tag-switch) instead of the old
// 3-op eager read — the consumer tax exceeds the producer savings on this
// branch-heavy workload. The WIN requires the compile-time adjacent cmp->branch
// fusion (the branch consuming the immediately-preceding cmp reads its operand
// locals DIRECTLY, bypassing pending-check AND shadow — sound because the
// shadow+pending backs only the cross-block readers). Foundation + tests kept
// for that follow-up. Flip to true ONLY together with the adjacent fusion.
// [PM57 2026-08-04] Built the adjacent cmp->branch fusion (CmpFuse below;
// emit_crbit_fused in jit_branch.cpp, threaded through emit_bcx + emit_bcx_fused)
// so the hot conditional branch consuming the immediately-preceding cmp reads
// its operand locals directly (~3 ops, no pending-check, no shadow), while
// non-adjacent / cross-block / mfcr-class readers still materialize from
// shadow+pending. CORRECT + SOUND (test_diff_next 3457/0 with lazy-CR ON;
// lazycr_fused_adjacent = 26 vecs x 3 bits x 2 pol incl sign boundaries, plus
// cross-block + SO-freeze + fused_intloop all green). MEASURED VERDICT (SAB
// same-session A/B, 120s presentN steady): default tiering ON {331,301}~316 vs
// eager {324,312}~318 = WASH (fully overlapping); --no-liftoff ON ~303-314 vs
// eager ~315 (stable) = neutral-to-slightly-negative. The fusion RECOVERS the
// PM56 lazy-CR-alone ~4% regression back to eager parity but yields NO page-fps
// win, because the redundant eager CR-build it removes is ALREADY DCE'd by
// TurboFan on hot (steady-state-dominant) code. Reverted to false per ship-only-
// measured-wins. Foundation + tests KEPT for the STRUCTURAL region-scope CR
// liveness (Phase B, lazy-cr-and-warmup-implementation-plan.md) where the
// elision is provable-dead, not redundant-with-DCE.
static constexpr bool BEM_LAZY_CR = false;

// One deferred CR-field record. 12 bytes; stride matters — emitters address
// &g_bem_cr_shadow[crfd] + {0,4,8,9}.
struct BemCrShadow {
    int32_t  a;       // +0  operand A (compare LHS, or RC result value)
    int32_t  b;       // +4  operand B (compare RHS / baked imm); unused for RC_VS0
    uint8_t  tag;     // +8  BemCrTag (kind | signed)
    uint8_t  so;      // +9  XER.SO snapshot at produce (bit0), frozen
    uint8_t  pad0;    // +10
    uint8_t  pad1;    // +11
};

enum BemCrTag : uint8_t {
    BEM_CR_CMP_REG   = 0,     // a,b are register values
    BEM_CR_CMP_IMM   = 1,     // a = register value, b = baked immediate const
    BEM_CR_RC_VS0    = 2,     // a = result value, compared vs 0 (signed)
    BEM_CR_KIND_MASK = 0x03,
    BEM_CR_UNSIGNED  = 0x04,  // OR into tag for cmpl/cmpli
};

extern "C" {
extern BemCrShadow g_bem_cr_shadow[8];
extern uint8_t     g_bem_cr_pending[8];
}

// [PM57 adjacent cmp->branch fusion] Compile-time peephole record. A deferring
// cmp (lazy-CR) stashes its operand LOCALS + kind here so an immediately-
// following conditional branch reading the SAME CR field can emit a direct
// operand compare (~3 ops: local.get a; local.get b / i32.const imm; i32.{lt,gt,
// eq}) instead of the pending-check + tag-switch materialize path. SOUND: the
// cmp still writes the shadow+pending (cr_encode.cpp), which backs every cross-
// block / non-adjacent / later reader; the fuse only shortcuts the ADJACENT
// consumer. The preg->wasm-local map is identity+block-stable (reg_cache.h:62,
// local_idx = base+preg) and Bind(Read) guarantees the local holds the runtime
// value, so a_local/b_local stay valid; adjacency (age gate below) guards the
// case where an intervening op could rewrite them. Loop-scoped in
// emit_block_body_into (like EaCache); the dispatch loop ages it out so it is
// consumable ONLY by the op immediately after the cmp (age 0 at set -> 1 after
// the cmp's op -> cleared after the next op, consumed or not). A later cmp
// refreshes age to 0. INERT when BEM_LAZY_CR is false (no cmp ever sets it).
struct CmpFuse {
    bool     valid     = false;
    uint8_t  age       = 0;      // 0 = set this op; 1 = last chance (next op)
    uint32_t crfd      = 0;      // CR field the cmp wrote; branch bi/4 must match
    uint32_t a_local   = 0;      // wasm local holding operand A (guest RA value)
    uint32_t b_local   = 0;      // wasm local holding operand B (when !is_imm)
    int32_t  imm       = 0;      // baked immediate (when is_imm)
    bool     is_imm    = false;
    bool     is_signed = true;   // cmp/cmpi signed; cmpl/cmpli unsigned
};

}  // namespace bemental::powerpc
