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

// [simd-paired] NaN-payload-exact ConvertToDouble(f32 bits in LOCAL_PSQ_T0=98)
// -> pushes i64 f64-bits. Defined in jit_load_store.cpp; forward-declared here
// to avoid pulling the whole jit_load_store.h surface into the reg cache.
void emit_psq_convert_to_double(WasmModuleBuilder& wb);
// [single-spec PM26] exact inverse of the PEM widen (jit_load_store.cpp) —
// i64 lane local -> f32 bits on stack, round-trip identity incl. NaN payloads
// + single denormals. Clobbers LOCAL_TMP_VAL (=95).
void emit_convert_to_single(WasmModuleBuilder& wb, u32 ps0_local);
static constexpr u32 LOCAL_PSQ_T0 = 98u;  // shared i32 scratch (jit_load_store.cpp:1061)
static constexpr u32 LOCAL_PSQ_T1 = 99u;  // shared i32 scratch (dead at flush points)

// [single-spec PM26] shadow mask: SAB u32, bit i = "ps[i] MEMORY holds
// f32-valued data in BOTH lanes" (i.e. the last writer flushed a Single-repr
// value through the PEM widen). Maintained by Flush below; cleared wholesale
// by ReloadAll (host mutated ps[]) and by JitWasm at CachedInterpreter
// fallbacks. Consumed by the block prologue's speculation guard
// (ppc_emit.cpp). All emitted accesses gated on g_bem_lc_base (the "big SAB
// present" gate — test harness memories are small and must not take absolute
// stores; consequence: the speculation machinery is NOT conformance-covered,
// validated by boot + cross-game probes + the simd census, same class as the
// fastmem region classifier).
static constexpr u32 BEM_SINGLE_MASK_CELL = 0x026B33E0u;
extern "C" { extern uint32_t g_bem_lc_base; }

FPRRegCache::FPRRegCache(WasmModuleBuilder& wb)
    : m_wb(wb) {}

// OnBlockEntry — reserve two contiguous i64 wasm-local indices per FPR.
// Convention: ps0 lanes at [base..base+31], ps1 lanes at [base+32..base+63].
// Live-in pregs (block.m_fpr_inputs) get the assigned bit so the prologue
// emits their loads. Other pregs are lazily assigned on first Bind.
void FPRRegCache::OnBlockEntry(const CodeBlock& block, u32 wasm_local_base,
                               u32 ctx_ptr, u32 v128_local_base) {
    m_local_base   = wasm_local_base;
    m_v128_base    = v128_local_base;
    m_if_depth     = 0;
    m_lazy_ctx_ptr = ctx_ptr;
    for (u32 i = 0; i < 32; ++i) {
        m_state[i] = PregState{};
        m_state[i].ps0_local_idx  = wasm_local_base + i;
        m_state[i].ps1_local_idx  = wasm_local_base + 32u + i;
        m_state[i].v128_local_idx = v128_local_base + i;
        m_state[i].repr = FPRPrec::Double;   // memory is f64; single is produced
        if (block.m_fpr_inputs[i]) {
            m_state[i].assigned = true;
        }
    }
}

// EmitPromoteToDouble — reconcile a Single-repr FPR (v128 f32x2) back into its
// i64 lane pair, per-lane, via the NaN-payload-exact ConvertToDouble widen
// (matches the interpreter's ps[] f64 write). Sets repr=Double, lanes dirty.
void FPRRegCache::EmitPromoteToDouble(u32 preg) {
    PregState& s = m_state[preg];
    for (u8 lane = 0; lane < 2; ++lane) {
        m_wb.op_local_get(s.v128_local_idx);
        m_wb.op_f32x4_extract_lane(lane);
        m_wb.op_i32_reinterpret_f32();
        m_wb.op_local_set(LOCAL_PSQ_T0);
        emit_psq_convert_to_double(m_wb);           // -> i64 f64-bits
        m_wb.op_local_set(lane == 0 ? s.ps0_local_idx : s.ps1_local_idx);
    }
    s.repr = FPRPrec::Double;
    s.v128_dirty = false;
    s.ps0_loaded = s.ps1_loaded = true;
    s.ps0_dirty  = s.ps1_dirty  = true;
    s.value_single  = true;              // [single-spec v3] widened single
    s.value_unknown = false;
}

// EmitPrologueLoads — for every live-in preg, emit i64 loads for BOTH lanes.
// Matches Jit64 FPURegCache.cpp:60-64 (MOVAPD loads ps0+ps1 as one 16-byte op).
void FPRRegCache::EmitPrologueLoads(u32 ctx_ptr) {
    for (u32 i = 0; i < 32; ++i) {
        if (!m_state[i].assigned) continue;
        // [self-loop PM47] Single-repr regs: the live value is the v128; their
        // lanes are derived on demand via EmitPromoteToDouble (never lazily
        // ps[]-loaded). Loading ps[] here would be redundant on the verified
        // entry and STALE on the fast re-entry.
        if (m_state[i].repr == FPRPrec::Single) continue;
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
        s.ps0_local_idx  = m_local_base + preg;
        s.ps1_local_idx  = m_local_base + 32u + preg;
        s.v128_local_idx = m_v128_base + preg;
        s.assigned = true;
    }
    // [simd-paired] A double-domain consumer must see the i64 pair. If the live
    // value is in single form, reconcile it first (repr->Double, lanes loaded).
    if (s.repr == FPRPrec::Single) {
        EmitPromoteToDouble(preg);
    }
    // 2026-06-11: lazy-load fires for PURE-WRITE binds too — same class as
    // RegCache::Bind (see reg_cache.cpp): an RMW emitter that binds the
    // dest lane first and then reads the same lane would consume the
    // zero-initialized wasm local instead of PowerPCState. One redundant
    // i64.load per first-touch lane is the price.
    if ((lane_mask & FPR_LANE_PS0) && !s.ps0_loaded) {
        EmitLaneLoad(m_lazy_ctx_ptr, preg, FPR_LANE_PS0);
    }
    if ((lane_mask & FPR_LANE_PS1) && !s.ps1_loaded) {
        EmitLaneLoad(m_lazy_ctx_ptr, preg, FPR_LANE_PS1);
    }
    if (mode == FPRMode::Write || mode == FPRMode::ReadWrite) {
        if (lane_mask & FPR_LANE_PS0) s.ps0_dirty = true;
        if (lane_mask & FPR_LANE_PS1) s.ps1_dirty = true;
        // [single-spec v3] conservative: any Double-domain write clears the
        // value flags; single/unknown producers re-mark afterward.
        s.value_single  = false;
        s.value_unknown = false;
    }
    RCFprPair r; r.ps0_idx = s.ps0_local_idx; r.ps1_idx = s.ps1_local_idx;
    r.v128_idx = s.v128_local_idx; r.is_single = false;
    return r;
}

// BindSingleRead — the FPR is already Single (caller checked IsSingle). Just
// hand back its v128 local. No conversion, no emit.
RCFprPair FPRRegCache::BindSingleRead(u32 preg) {
    PregState& s = m_state[preg];
    RCFprPair r; r.ps0_idx = s.ps0_local_idx; r.ps1_idx = s.ps1_local_idx;
    r.v128_idx = s.v128_local_idx; r.is_single = true;
    return r;
}

// BindSingleWrite — mark the FPR Single; the op writes an f32x2 into the v128
// local. The i64 pair is now stale (not dirty — reconciled lazily from v128).
RCFprPair FPRRegCache::BindSingleWrite(u32 preg) {
    PregState& s = m_state[preg];
    if (!s.assigned) {
        s.ps0_local_idx  = m_local_base + preg;
        s.ps1_local_idx  = m_local_base + 32u + preg;
        s.v128_local_idx = m_v128_base + preg;
        s.assigned = true;
    }
    s.repr = FPRPrec::Single;
    s.v128_dirty = true;
    s.ps0_dirty = s.ps1_dirty = false;   // i64 form stale, not to be flushed
    s.value_single  = true;              // [single-spec v3]
    s.value_unknown = false;
    RCFprPair r; r.ps0_idx = s.ps0_local_idx; r.ps1_idx = s.ps1_local_idx;
    r.v128_idx = s.v128_local_idx; r.is_single = true;
    return r;
}

// Flush dirty lanes back to PowerPCState.
void FPRRegCache::Flush(u32 ctx_ptr, BitSet32 preg_mask, u8 lane_mask) {
    for (u32 i = 0; i < 32; ++i) {
        if (!preg_mask[i]) continue;
        // [single-spec PM26] latch BEFORE the promote — EmitPromoteToDouble
        // flips repr to Double and dirties both lanes, so a post-store repr
        // check would mis-classify the value we just widened from a Single.
        const bool was_single =
            m_state[i].repr == FPRPrec::Single &&
            (m_state[i].v128_dirty || m_force_flush[i]);   // [self-loop PM47]
        // [single-spec v3] value-singleness survives repr: scalar ps paths
        // store ForceSingle'd widened singles through Double-repr lanes.
        const bool value_single = was_single || m_state[i].value_single;
        // [simd-paired] A Single-form FPR must be promoted to f64 before its
        // i64 pair is stored — PowerPCState.ps[] is always f64.
        if (was_single) {
            EmitPromoteToDouble(i);   // repr->Double, both lanes dirty
        }
        const bool st0 = (lane_mask & FPR_LANE_PS0) && m_state[i].ps0_dirty;
        const bool st1 = (lane_mask & FPR_LANE_PS1) && m_state[i].ps1_dirty;
        if (st0) EmitLaneStore(ctx_ptr, i, FPR_LANE_PS0);
        if (st1) EmitLaneStore(ctx_ptr, i, FPR_LANE_PS1);
        // [single-spec PM26] shadow-mask RMW: a full both-lane Single flush
        // marks ps[i] f32-valued; a Double store clears it. [v5 lfd
        // tri-state] value_unknown (lfd-written) instead ANDs a RUNTIME
        // round-trip check of the stored lanes into the existing bit:
        // bit' = bit & all(widen(narrow(lane)) == lane). Unstored lanes keep
        // their contribution via the old bit. So __OSLoadFPUContext's
        // ps0-only lfd restore of a round-tripped single KEEPS the bit while
        // a genuine double clears it — and the AND rule can never wrongly
        // SET. (A genuine double that round-trips f32-exactly IS losslessly
        // narrowable, so keeping the bit for it is correct by definition.)
        if ((st0 || st1) && g_bem_lc_base) {
            if (value_single && lane_mask == FPR_LANE_BOTH) {
                m_wb.op_i32_const((s32)BEM_SINGLE_MASK_CELL);
                m_wb.op_i32_const((s32)BEM_SINGLE_MASK_CELL);
                m_wb.op_i32_load(0);
                m_wb.op_i32_const((s32)(1u << i));
                m_wb.op_i32_or();
                m_wb.op_i32_store(0);
            } else if (m_state[i].value_unknown) {
                // [v6 SET-capable] verify BOTH lanes at runtime and set/clear
                // accordingly. Keep-only (old & ok) was insufficient: MusyX's
                // ISR work legitimately doubles f27-f30 (bits correctly
                // clear), the __OSLoadFPUContext lfd-restore brings the
                // singles back, and a keep-rule left the bits cleared for the
                // rest of the interrupted IDCT call (failBits=0x78000000,
                // f31-untouched-by-MusyX staying set was the tell). Unstored
                // lanes are verified from their lane locals — loaded here if
                // needed (local == memory for clean lanes by construction).
                if (!m_state[i].ps0_loaded) EmitLaneLoad(ctx_ptr, i, FPR_LANE_PS0);
                if (!m_state[i].ps1_loaded) EmitLaneLoad(ctx_ptr, i, FPR_LANE_PS1);
                m_wb.op_i32_const((s32)BEM_SINGLE_MASK_CELL);   // store addr
                m_wb.op_i32_const((s32)BEM_SINGLE_MASK_CELL);
                m_wb.op_i32_load(0);
                m_wb.op_local_set(LOCAL_PSQ_T1);                // old
                m_wb.op_local_get(LOCAL_PSQ_T1);
                m_wb.op_i32_const((s32)(1u << i));
                m_wb.op_i32_or();                               // set-value
                m_wb.op_local_get(LOCAL_PSQ_T1);
                m_wb.op_i32_const((s32)~(1u << i));
                m_wb.op_i32_and();                              // clear-value
                bool first = true;
                auto lane_roundtrip_ok = [&](u32 lane_local) {
                    // widen(narrow(x)) == x — both directions are the exact
                    // PEM pair, so this is precisely "x is a widened single"
                    // (NaN payloads and single denormals included).
                    emit_convert_to_single(m_wb, lane_local);   // i32 bits
                    m_wb.op_local_set(LOCAL_PSQ_T0);
                    emit_psq_convert_to_double(m_wb);           // i64 widened
                    m_wb.op_local_get(lane_local);
                    m_wb.op_i64_xor();
                    m_wb.op_i64_eqz();                          // 1 iff equal
                    if (!first) m_wb.op_i32_and();
                    first = false;
                };
                lane_roundtrip_ok(m_state[i].ps0_local_idx);
                lane_roundtrip_ok(m_state[i].ps1_local_idx);
                m_wb.op_select();                               // ok ? set : clear
                m_wb.op_i32_store(0);
            } else {
                m_wb.op_i32_const((s32)BEM_SINGLE_MASK_CELL);
                m_wb.op_i32_const((s32)BEM_SINGLE_MASK_CELL);
                m_wb.op_i32_load(0);
                m_wb.op_i32_const((s32)~(1u << i));
                m_wb.op_i32_and();
                m_wb.op_i32_store(0);
            }
        }
    }
}

// [single-spec PM26] EmitAssumedSingleLoads — prologue loads for FPRs the
// block ASSUMES are f32-valued in ps[] (the caller has already emitted the
// shadow-mask guard; this runs only on the match arm). Per FPR: load both
// i64 lanes into the lane locals (kept coherent for any Double consumer),
// then recover the EXACT f32 bits per lane via emit_convert_to_single (the
// PEM widen's inverse — NaN payloads + single denormals survive, which
// f32.demote_f64 would not guarantee) and build the v128 [ps0,ps1,ps0,ps0].
// Compile-time state: repr=Single, v128 NOT dirty (memory already matches),
// lanes loaded + clean — a block that never writes the FPR flushes nothing.
void FPRRegCache::EmitAssumedSingleLoads(u32 ctx_ptr, BitSet32 assumed,
                                         bool fast_loop_mode) {
    for (u32 i = 0; i < 32; ++i) {
        if (!assumed[i]) continue;
        PregState& s = m_state[i];
        if (!s.assigned) {
            s.ps0_local_idx  = m_local_base + i;
            s.ps1_local_idx  = m_local_base + 32u + i;
            s.v128_local_idx = m_v128_base + i;
            s.assigned = true;
        }
        EmitLaneLoad(ctx_ptr, i, FPR_LANE_PS0);
        EmitLaneLoad(ctx_ptr, i, FPR_LANE_PS1);
        emit_convert_to_single(m_wb, s.ps0_local_idx);   // f32 bits (i32)
        m_wb.op_f32_reinterpret_i32();
        m_wb.op_f32x4_splat();                           // [ps0,ps0,ps0,ps0]
        emit_convert_to_single(m_wb, s.ps1_local_idx);
        m_wb.op_f32_reinterpret_i32();
        m_wb.op_f32x4_replace_lane(1);                   // [ps0,ps1,ps0,ps0]
        m_wb.op_local_set(s.v128_local_idx);
        if (fast_loop_mode) {
            // [self-loop PM47] seed the scratch window so a subsequent fast
            // re-entry (flag proves our own arm was the last exit) can rebuild
            // this v128 with ONE load; land the fast-uniform state: v128
            // valid + DIRTY (forces the full-exit flush even when untouched —
            // the small price for one state shared by both entry paths),
            // lanes UNLOADED (fast path never loads them; lazy on demand).
            m_wb.op_i32_const((s32)(0x026B3C00u + i * 16u));
            m_wb.op_local_get(s.v128_local_idx);
            m_wb.op_v128_store(0);
            // [PM47 v2] CLEAN at entry — common-path flush sites (MSR.FP
            // bailout) must emit nothing for these; the force-flush set
            // makes real host-visible flushes still write them.
            s.repr = FPRPrec::Single;
            s.v128_dirty = false;
            s.ps0_loaded = s.ps1_loaded = false;
            s.ps0_dirty = s.ps1_dirty = false;
        } else {
            s.repr = FPRPrec::Single;
            s.v128_dirty = false;                        // memory matches
            s.ps0_dirty = s.ps1_dirty = false;
        }
        s.value_single  = true;                          // [single-spec v3]
        s.value_unknown = false;
    }
}

// [self-loop PM47] Fast re-entry — see header. One v128.load per assumed reg
// from the scratch window our own singles arm spilled at its self-chain exit.
void FPRRegCache::EmitFastReentry(BitSet32 assumed) {
    for (u32 i = 0; i < 32; ++i) {
        if (!assumed[i]) continue;
        PregState& s = m_state[i];
        if (!s.assigned) {
            s.ps0_local_idx  = m_local_base + i;
            s.ps1_local_idx  = m_local_base + 32u + i;
            s.v128_local_idx = m_v128_base + i;
            s.assigned = true;
        }
        m_wb.op_i32_const((s32)(0x026B3C00u + i * 16u));
        m_wb.op_v128_load(0);
        m_wb.op_local_set(s.v128_local_idx);
        // [PM47 v2] CLEAN despite stale ps[] — the force-flush set covers
        // every host-visible Flush; common-path flush sites stay empty.
        s.repr = FPRPrec::Single;
        s.v128_dirty = false;
        s.ps0_loaded = s.ps1_loaded = false;
        s.ps0_dirty = s.ps1_dirty = false;
        s.value_single  = true;
        s.value_unknown = false;
    }
}

// [self-loop PM47] Spill assumed v128s to scratch (caller checked AllSingle).
void FPRRegCache::EmitScratchSpill(BitSet32 assumed) {
    for (u32 i = 0; i < 32; ++i) {
        if (!assumed[i]) continue;
        m_wb.op_i32_const((s32)(0x026B3C00u + i * 16u));
        m_wb.op_local_get(m_state[i].v128_local_idx);
        m_wb.op_v128_store(0);
    }
}

// ReloadAll — for every assigned FPR, re-load both lanes from PowerPCState.
// Used after host mutations of ps[] (interp fallback, HLE that may touch
// FPRs). Clears dirty bits to keep state coherent with what we just wrote.
void FPRRegCache::ReloadAll(u32 ctx_ptr, bool host_may_write_fprs) {
    // [single-spec PM26] host mutated ps[] (interp fallback / HLE) — the
    // shadow mask is stale for every FPR; clear it wholesale (conservative).
    // [v7] SKIPPED for fallbacks that cannot write ps[] — see the header.
    if (g_bem_lc_base && host_may_write_fprs) {
        m_wb.op_i32_const((s32)BEM_SINGLE_MASK_CELL);
        m_wb.op_i32_const(0);
        m_wb.op_i32_store(0);
        // [self-loop PM47] the host may have rewritten ps[]: the self-chain
        // scratch is stale too — invalidate the flag alongside the mask.
        m_wb.op_i32_const((s32)0x026B38C0u);
        m_wb.op_i32_const(0);
        m_wb.op_i32_store(0);
    }
    for (u32 i = 0; i < 32; ++i) {
        if (!m_state[i].assigned) continue;
        // [simd-paired] Host mutated ps[] (f64) — memory is authoritative; drop
        // any single-form value and reload the i64 pair.
        m_state[i].repr = FPRPrec::Double;
        m_state[i].v128_dirty = false;
        m_state[i].value_single  = false;  // [single-spec v3] host wrote ps[]
        m_state[i].value_unknown = false;
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
