// gekko_emit.h — Gekko (PowerPC 750CL) → WASM instruction emitters.
//
// Translates one decoded Gekko instruction into WASM bytecode using
// WasmModuleBuilder. Operates on a Dolphin PowerPCState in shared linear
// memory (passed in as local 0). Anything not implemented natively falls
// through to a wasm_interp_fallback import that re-uses Dolphin's existing
// Interpreter::RunInterpreterOp for the instruction.
//
// Decoder structure mirrors Dolphin's Interpreter_Tables.cpp:
//   primary[64]  — top-6-bit OPCD                       (gekko_emit.cpp)
//     ↳ 4   → table4 [1024]    paired-singles + dcbz_l
//     ↳ 19  → table19 [1024]   bclr/bcctr/cr_logic/rfi
//     ↳ 31  → table31 [1024]   integer/memory X-form
//     ↳ 59  → table59 [32]     fp single
//     ↳ 63  → table63 [1024]   fp double + fpscr ops

#pragma once
#include "bementalJIT/wasm_module_builder.h"
#include "bementalJIT/types.h"

namespace bemental::powerpc {

// ---------------------------------------------------------------------------
// Imports the JIT host MUST provide when instantiating a compiled block.
// Order is fixed; consumer is responsible for matching it during module setup.
// ---------------------------------------------------------------------------
enum WasmImportFunc : u32 {
    WIMPORT_READ8       = 0,   // (addr) -> i32
    WIMPORT_READ16      = 1,   // (addr) -> i32
    WIMPORT_READ32      = 2,   // (addr) -> i32
    WIMPORT_WRITE8      = 3,   // (addr, val) -> void
    WIMPORT_WRITE16     = 4,   // (addr, val) -> void
    WIMPORT_WRITE32     = 5,   // (addr, val) -> void
    WIMPORT_INTERP      = 6,   // (inst_word, pc) -> void   — fallback to interp
    WIMPORT_CHECK_EXC   = 7,   // (pc) -> i32               — non-zero = early-exit
    WIMPORT_BREAK_BLOCK = 8,   // (pc) -> void              — block exit hook
    WIMPORT_HLE_CHECK   = 9,   // (pc) -> i32               — non-zero = HLE replaced, bail
    WIMPORT_COUNT       = 10
};

// ---------------------------------------------------------------------------
// Local layout for emitted block functions.
//   () -> i32 returning next-PC for the dispatcher to look up.
// Locals 0/1 are scratch i32s reserved by the prologue.
// ---------------------------------------------------------------------------
constexpr u32 LOCAL_TMP_A = 0;
constexpr u32 LOCAL_TMP_B = 1;
constexpr u32 LOCAL_TMP_COUNT = 2;
// Single f64 scratch local for FP arith store-fill (used by op59/op63
// emitters). Index = LOCAL_TMP_COUNT since locals are appended after the
// i32 group declared in emit_body_into's emitLocals call.
constexpr u32 LOCAL_TMP_F = 2;
// B11 — per-block GPR cache. 32 i32 locals, one per PowerPC GPR, declared
// AFTER the f64 local so LOCAL_TMP_F's index is unaffected. Indices
// GPR_LOCAL_BASE..GPR_LOCAL_BASE+31. Allocated whether or not
// EmitCtx::use_gpr_locals is set; V8 elides unused locals.
constexpr u32 GPR_LOCAL_BASE = 3u;
inline constexpr u32 gpr_local_idx(u32 i) { return GPR_LOCAL_BASE + i; }

// ---------------------------------------------------------------------------
// PowerPCState field offsets, in bytes from the start of the struct.
// Source of truth: gamecube/dolphin-src/Source/Core/Core/PowerPC/PowerPC.h.
// Computed for wasm32 (sizeof(void*) == 4) — Dolphin's PowerPCState contains
// three u8* host pointers between npc and gpr (stored_stack_pointer +
// gather_pipe_ptr + gather_pipe_base_ptr).
// JitWasm.cpp asserts these with offsetof at compile time; if a Dolphin
// upgrade shifts the layout, those static_asserts fail loudly here, not at
// runtime via corrupted register state.
// ---------------------------------------------------------------------------
namespace ppc_off {
    constexpr u32 PC                = 0x000;
    constexpr u32 NPC               = 0x004;
    constexpr u32 STORED_STACK_PTR  = 0x008;
    // gather_pipe_ptr               0x00C
    // gather_pipe_base_ptr          0x010
    constexpr u32 GPR_BASE          = 0x014;   // gpr[32]                ends at 0x094
    // 12 bytes of padding to align ps[32] to 16
    constexpr u32 PS_BASE           = 0x0A0;   // 32 PairedSingles       ends at 0x2A0
    constexpr u32 CR_BASE           = 0x2A0;   // 8 u64 fields           ends at 0x2E0
    constexpr u32 MSR               = 0x2E0;
    constexpr u32 FPSCR             = 0x2E4;
    constexpr u32 FEATURE_FLAGS     = 0x2E8;
    constexpr u32 EXCEPTIONS        = 0x2EC;
    constexpr u32 DOWNCOUNT         = 0x2F0;
    constexpr u32 XER_CA            = 0x2F4;
    constexpr u32 XER_SO_OV         = 0x2F5;
    constexpr u32 XER_STRINGCTRL    = 0x2F6;   // u16
    constexpr u32 RESERVE_ADDRESS   = 0x2F8;
    constexpr u32 RESERVE           = 0x2FC;   // bool
    // After reserve (1B) + pagetable_update_pending (1B) + m_enable_dcache (1B)
    // + 1B padding, sr[16] starts at 0x300 (64B → ends 0x340), then
    // alignas(8) spr[1024] starts at 0x340 (4096B → ends 0x1340).
    // JitWasm.cpp asserts this with offsetof at compile time.
    constexpr u32 SR_BASE           = 0x300;   // u32 sr[16]
    constexpr u32 SPR_BASE          = 0x340;   // u32 spr[1024]

    // Helpers
    inline constexpr u32 gpr(u32 i)  { return GPR_BASE + i * 4u; }
    // PairedSingle = 16 bytes (two f64 storage slots, but ps0/ps1 are the
    // first two u64s — we read/write as u64 pairs).
    inline constexpr u32 ps0(u32 i)  { return PS_BASE + i * 16u + 0u; }
    inline constexpr u32 ps1(u32 i)  { return PS_BASE + i * 16u + 8u; }
    // CR is 8 u64 fields (one per CR field 0..7). For simple CR0-set ops we
    // touch the low 32 bits of field 0.
    inline constexpr u32 cr_field(u32 i) { return CR_BASE + i * 8u; }
    inline constexpr u32 spr(u32 i)  { return SPR_BASE + i * 4u; }
}

// PowerPC mfspr/mtspr split-nibble SPR field decode. Inst bits 11-15 hold
// SPR[5..9] (low 5 bits) and bits 16-20 hold SPR[0..4] (high 5 bits) in
// PPC's MSB-first numbering — the two halves are SWAPPED relative to the
// raw field. SPR_DECODE turns the raw 10-bit field into the SPR# index
// the ISA uses (e.g. SPR_LR = 8, SPR_CTR = 9, SPR_HID0 = 1008).
inline constexpr u32 SPR_DECODE(u32 inst) {
    const u32 raw = (inst >> 11) & 0x3FFu;
    return ((raw & 0x1Fu) << 5) | ((raw >> 5) & 0x1Fu);
}

// ---------------------------------------------------------------------------
// Gekko instruction-word field decoders (PowerPC 750CL conventions).
// All take the raw 32-bit big-endian-loaded instruction word.
// ---------------------------------------------------------------------------
inline constexpr u32 OPCD(u32 i)   { return (i >> 26) & 0x3F; }
inline constexpr u32 SUBOP10(u32 i){ return (i >> 1)  & 0x3FF; }
inline constexpr u32 SUBOP5(u32 i) { return (i >> 1)  & 0x1F; }
inline constexpr u32 RT(u32 i)     { return (i >> 21) & 0x1F; }   // also RS, BO
inline constexpr u32 RA(u32 i)     { return (i >> 16) & 0x1F; }   // also BI
inline constexpr u32 RB(u32 i)     { return (i >> 11) & 0x1F; }
inline constexpr u32 BO(u32 i)     { return (i >> 21) & 0x1F; }
inline constexpr u32 BI(u32 i)     { return (i >> 16) & 0x1F; }
inline constexpr u32 SH(u32 i)     { return (i >> 11) & 0x1F; }
inline constexpr u32 MB(u32 i)     { return (i >> 6)  & 0x1F; }
inline constexpr u32 ME(u32 i)     { return (i >> 1)  & 0x1F; }
inline constexpr u32 CRFD(u32 i)   { return (i >> 23) & 0x07; }
inline constexpr u32 CRFS(u32 i)   { return (i >> 18) & 0x07; }
inline constexpr u32 CRBD(u32 i)   { return (i >> 21) & 0x1F; }
inline constexpr u32 CRBA(u32 i)   { return (i >> 16) & 0x1F; }
inline constexpr u32 CRBB(u32 i)   { return (i >> 11) & 0x1F; }
inline constexpr u32 SPR(u32 i)    { return ((i >> 11) & 0x3FF); } // raw 10-bit SPR (split nibbles in real ISA — for mfspr/mtspr we just pass the raw inst to fallback for SPRs with side effects)
inline constexpr bool RC(u32 i)    { return (i & 0x1) != 0; }
inline constexpr bool LK(u32 i)    { return (i & 0x1) != 0; }
inline constexpr bool AA(u32 i)    { return (i & 0x2) != 0; }
inline constexpr bool OE(u32 i)    { return ((i >> 10) & 1) != 0; }
inline constexpr s32 SIMM_16(u32 i){ return (s32)(s16)(u16)(i & 0xFFFF); }
inline constexpr u32 UIMM_16(u32 i){ return i & 0xFFFFu; }
inline constexpr s32 BD(u32 i)     { return (s32)(s16)(u16)(i & 0xFFFC); }
inline constexpr s32 LI(u32 i)     {
    s32 disp = (s32)(i & 0x03FFFFFC);
    if (disp & 0x02000000) disp |= 0xFC000000;  // sign extend 26-bit
    return disp;
}

// ---------------------------------------------------------------------------
// Multi-module region target resolver. When a branch emitter has a static
// target PC and this callback resolves it to a same-region local fn idx,
// the emitter emits `return_call_indirect (table 0, type 0)` instead of
// `set_pc + return`. The call_indirect target lives in the merged
// region module's INTERNAL table, which is what V8's speculative inliner
// requires for cross-block inlining (see Gap 1 in the multi-module
// research). Returns true if `target_pc` is in the same region and writes
// the local fn idx to `*out_local_idx`; returns false otherwise (caller
// falls back to set_pc + return, host re-enters the dispatcher).
// ---------------------------------------------------------------------------
using LocalIdxLookupFn = bool(*)(const void* user, u32 target_pc, u32* out_local_idx);

// ---------------------------------------------------------------------------
// Per-instruction emit context.
// ---------------------------------------------------------------------------
struct EmitCtx {
    WasmModuleBuilder& b;
    u32  pc;                 // guest PC of this instruction
    u32  inst;               // raw instruction word
    u32  start_pc = 0u;      // guest PC of the first instruction of this block.
                             // Used to suppress self-block tail-calls so the
                             // host-side idle-skip detector can observe
                             // self-loops at the host-loop boundary.
    bool block_end;          // emitter sets to true to terminate the basic block
    // Multiblock chain hint: when this is `bc` (op 16, no LK) and the
    // instruction immediately following in the build_block buffer is the
    // bc's fall-through (pc + 4), this flag is true. The bc emitter then
    // emits ONLY the taken-side return — fall-through continues inline
    // into the next chained instruction, no block terminator. When false,
    // bc emits its standard if/else with both paths returning.
    bool chain_fallthrough;
    // Set by emit_fallback when an instruction routes to dolphin_interp.
    // gekko_emit_instr uses this to decide whether to emit a per-op
    // exception bail: native ops need it (they don't touch ppc_state.pc
    // and would keep running with corrupted state if a prior fallback
    // vectored PC); fallback ops don't (dolphin_interp's PC-divergence
    // guard in JitWasm.cpp already covers them). Reset per-op by
    // gekko_emit_instr; default-initialized so existing aggregate
    // initializers (build_block) don't need to be updated.
    bool used_fallback = false;
    // Multi-module region resolver — see LocalIdxLookupFn comment above.
    // Default null = legacy host-bounce behavior (every branch returns
    // its target PC for the dispatcher to re-look-up).
    LocalIdxLookupFn lookup_local_idx = nullptr;
    const void*      lookup_user      = nullptr;

    // B11 — per-block GPR-local cache state. When `use_gpr_locals` is true,
    // emit_gpr_get/set route through WASM locals (gpr_local_idx(i)) instead
    // of memory:
    //   - gpr_loaded[i]: this block has loaded gpr[i] from memory into the
    //     local at least once. Subsequent reads use the local directly.
    //   - gpr_dirty[i]: the local holds a value not yet written back to
    //     memory. Must be flushed before any path that hands control to
    //     code that reads ppc_state.gpr[i] (fallback, exception bail,
    //     branch return / tail-call, end of block).
    //
    // The fallback path also INVALIDATES the cache (sets gpr_loaded[i] =
    // gpr_dirty[i] = false for all i) because the interpreter may have
    // mutated ppc_state.gpr[i] via direct memory writes; locals would be
    // stale.
    bool use_gpr_locals = false;
    bool gpr_loaded[32] = {};
    bool gpr_dirty[32]  = {};
};

// Forward-declared core emit functions live in gekko_emit.cpp.
using EmitFn = void(*)(EmitCtx&);

// Look up the native emitter for a Gekko instruction word.
// Returns nullptr if no native emitter exists — in that case
// gekko_emit_instr will emit a fallback (interpreter call).
EmitFn gekko_lookup(u32 inst);

// Emit one instruction's worth of WASM into ctx.b. If no native emitter is
// available, emits a wasm_interp_fallback call.
void gekko_emit_instr(EmitCtx& ctx);

// Assemble a complete WASM module that, when run, executes a basic block of
// `count` Gekko instructions starting at `start_pc`. The returned module
// exports a single nullary function "run" that returns i32 = next PC to
// execute (the dispatcher loop in Dolphin uses this to chain blocks).
//
// Caller is responsible for passing a contiguous instruction buffer that
// already lives in host memory; the JIT does not fetch from guest RAM.
// build_block — assemble a WASM module that runs `count` PowerPC
// instructions starting at `start_pc`.
//   ctx_ptr_const   absolute address of PowerPCState within the host's
//                    linear memory (so emitted blocks can read/write GPRs
//                    via i32.load/store at compile-time-known offsets).
//   mem_pages        memory import minimum (0 ⇒ defaults to 1 page).
//   mem1_base        offset of MEM1 within the host's linear memory. When
//                    non-zero, D-form load/store emit a fast path that
//                    bypasses ppc_read*/ppc_write* trampolines for any
//                    address that lands in MEM1 (covers cached, uncached,
//                    and real-mode mirrors). 0 ⇒ disable the fast path.
//   mem1_mask        mask applied to addr after a successful range check;
//                    typically GetRamMask() == GetRamSize()-1.
//   ram_size         size of MEM1 in bytes; used by the runtime range
//                    check `(addr & 0x01FFFFFF) < ram_size`.
// `instr_pcs` is an optional parallel array giving the source PC of each
// instruction. When non-null, build_block uses it to handle multiblock
// chained streams: a `b` (op 18, no LK) whose target equals the next
// instruction's PC in the stream is NOT emitted as a terminator —
// emit continues with the chained instruction. When null, build_block
// derives PCs as start_pc + i*4 (single-block legacy path).
std::vector<u8> build_block(u32 start_pc, const u32* insts, u32 count,
                            u32 ctx_ptr_const, u32 mem_pages = 0,
                            u32 mem1_base = 0, u32 mem1_mask = 0,
                            u32 ram_size = 0,
                            const u32* instr_pcs = nullptr);

// ---------------------------------------------------------------------------
// Body-only counterpart to build_block. Emits a single function entry
// (5-byte LEB128 size prefix + locals + ops + 0x0B end) into a fresh
// WasmModuleBuilder and returns its bytes — exactly the format expected
// by BlockCache::region_accumulate. No module wrapper.
//
// Branches with static targets consult `lookup_fn` (if non-null) to
// resolve same-region targets to a local fn idx; resolved targets emit
// `return_call_indirect` (intra-module tail-call, V8-inline-able);
// unresolved targets emit set_pc + return (host re-enters dispatcher).
//
// Same per-block DFA + ctx_ptr/mem1 conventions as build_block.
// ---------------------------------------------------------------------------
std::vector<u8> emit_block_body(u32 start_pc, const u32* insts, u32 count,
                                u32 ctx_ptr_const,
                                u32 mem1_base = 0, u32 mem1_mask = 0,
                                u32 ram_size = 0,
                                const u32* instr_pcs = nullptr,
                                LocalIdxLookupFn lookup_fn = nullptr,
                                const void* lookup_user = nullptr);

// ---------------------------------------------------------------------------
// Multi-module region build. Wraps N concatenated function bodies into a
// single WASM module with the standard import set (memory + WIMPORT_COUNT
// host functions) and an INTERNAL funcref table populated with all N
// bodies via an active element segment. Each body is exported as
// `fn_<i>` so the dispatcher can enter at any block.
//
// `concatenated_bodies` is the raw byte stream of N function entries in
// code-section form (5-byte LEB128 size prefix + locals + ops + 0x0B
// end), exactly as produced by WasmModuleBuilder between beginFuncBody()
// and endFuncBody(). Bodies are concatenated in local-fn-idx order;
// fn_<i> corresponds to the i-th body in the buffer.
//
// V8 inlining note: the table is declared internally (table section) and
// populated via element segment, not imported. This is the load-bearing
// invariant — V8's speculative inliner only inlines call_indirect
// targets when caller and target live in the same instance.
// ---------------------------------------------------------------------------
std::vector<u8> build_region_module(const u8* concatenated_bodies,
                                    std::size_t concatenated_size,
                                    u32 n_funcs,
                                    u32 mem_pages = 1);

// ---------------------------------------------------------------------------
// Inline helpers used by the .cpp emitter implementations.
// (Kept in the header so individual emit functions can be defined inline
// alongside their declarations.)
// ---------------------------------------------------------------------------

// Push the address of PowerPCState onto the stack. We use a fixed i32 const
// so the compiled blocks don't need to take ctx as a parameter.
inline void emit_ctx(EmitCtx& c, u32 ctx_ptr) {
    c.b.op_i32_const((s32)ctx_ptr);
}

// Push gpr[i] onto the WASM stack (i32).
inline void emit_load_gpr(EmitCtx& c, u32 ctx_ptr, u32 i) {
    if (i == 0) { c.b.op_i32_const(0); return; }   // r0 reads as 0 in disp-form addressing? No — only in lis/addi. Caller decides.
    c.b.op_i32_const((s32)ctx_ptr);
    c.b.op_i32_load(ppc_off::gpr(i));
}

// As emit_load_gpr but follows the PPC "RA==0 ⇒ 0" rule for d-form addressing.
inline void emit_load_gpr_or_zero(EmitCtx& c, u32 ctx_ptr, u32 i) {
    if (i == 0) {
        c.b.op_i32_const(0);
        return;
    }
    c.b.op_i32_const((s32)ctx_ptr);
    c.b.op_i32_load(ppc_off::gpr(i));
}

// Plain load — does NOT apply the RA==0 rule.
inline void emit_load_gpr_raw(EmitCtx& c, u32 ctx_ptr, u32 i) {
    c.b.op_i32_const((s32)ctx_ptr);
    c.b.op_i32_load(ppc_off::gpr(i));
}

// Pre-store: push ctx so caller can compute value and call emit_store_gpr.
inline void emit_pre_store_gpr(EmitCtx& c, u32 ctx_ptr) {
    c.b.op_i32_const((s32)ctx_ptr);
}

// Stack: [ctx, value]; consumes both, stores value to gpr[i].
inline void emit_store_gpr(EmitCtx& c, u32 i) {
    c.b.op_i32_store(ppc_off::gpr(i));
}

// ---------------------------------------------------------------------------
// B11 GPR-local cache helpers (gekko_emit.cpp uses g_ctx_ptr as the address
// constant; these helpers reach for it lazily via the unified pattern).
// ---------------------------------------------------------------------------

// Forward declare; defined in gekko_emit.cpp where g_ctx_ptr lives.
void emit_gpr_get_impl(EmitCtx& c, u32 i, u32 ctx_ptr);
void emit_gpr_set_impl(EmitCtx& c, u32 i, u32 ctx_ptr);
void emit_flush_dirty_gprs_impl(EmitCtx& c, u32 ctx_ptr);
void emit_invalidate_gpr_locals(EmitCtx& c);

// CR0 quick-set: given an i32 value already on the stack, compute and write
// CR0 = SLT|SGT|EQ|SO  (4-bit field stored in low byte of cr.fields[0]).
// Implements the typical "Rc=1" behavior: signed compare against 0.
// Stack effect: [val] -> [].
//
// CR0 layout in the low byte of cr.fields[0]:
//   bit3: LT (signed less than 0)
//   bit2: GT (signed greater than 0)
//   bit1: EQ
//   bit0: SO (copy of XER.SO — we approximate as 0 for now)
inline void emit_set_cr0(EmitCtx& c, u32 ctx_ptr) {
    // Dolphin's ConditionRegister encoding (per ConditionRegister.h):
    //   - bit 32 of u64 (= high u32 bit 0) ALWAYS set (PPCToInternal marker)
    //   - LT ⇔ bit 62 of u64 (= high u32 bit 30)
    //   - SO ⇔ bit 59 of u64 (= high u32 bit 27)
    //   - EQ ⇔ low 32 bits == 0
    //   - GT ⇔ (s64)cr_val > 0  (i.e., bit 63 is 0 AND value is non-zero)
    //
    // The previous implementation used `result >> 31 signed` for the high
    // u32, which fills high with 0xFFFFFFFF for negative results — that
    // sets bit 27 (SO) as a side effect, which differential testing
    // (DolphinPPCTests oracle) caught: ADD. with negative result reported
    // SO=1 in CR0, contradicting real-Wii reference. emit_set_cr0 must
    // set ONLY bit 30 (LT) for negative results, not bit 27 (SO).
    //
    // Correct encoding for the high u32 of cr.fields[0]:
    //   bit 0   = 1  (always-set marker matching PPCToInternal)
    //   bit 30  = (result < 0)        — LT
    //   bit 31  = (result <= 0)        — encodes "NOT GT" so (s64)cr_val
    //                                    is non-positive when result <= 0,
    //                                    making Dolphin's GT check return 0.
    //   bit 27  = 0  (SO; intentionally unset — XER.SO is not tracked here.
    //                Real PPC sets CR0.SO from XER.SO; we leave it 0
    //                because non-overflow Rc=1 ops do not set XER.SO.)
    c.b.op_local_tee(LOCAL_TMP_A);
    c.b.op_drop();
    // Store low 32 = result.
    c.b.op_i32_const((s32)ctx_ptr);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_store(ppc_off::cr_field(0));
    // Compute and store high 32.
    c.b.op_i32_const((s32)ctx_ptr);
    // bit 30 = sign-bit << 30 (LT)
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(31);
    c.b.op_i32_shr_u();
    c.b.op_i32_const(30);
    c.b.op_i32_shl();
    // OR with bit 31 = (result <= 0 signed)
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(0);
    c.b.op_i32_le_s();
    c.b.op_i32_const(31);
    c.b.op_i32_shl();
    c.b.op_i32_or();
    // OR with bit 0 marker (always set per Dolphin's PPCToInternal).
    c.b.op_i32_const(1);
    c.b.op_i32_or();
    c.b.op_i32_store(ppc_off::cr_field(0) + 4);
}

// Update PC field of context.
inline void emit_set_pc(EmitCtx& c, u32 ctx_ptr, u32 new_pc) {
    c.b.op_i32_const((s32)ctx_ptr);
    c.b.op_i32_const((s32)new_pc);
    c.b.op_i32_store(ppc_off::PC);
}

// Update PC field from a value already on stack.
inline void emit_set_pc_dyn(EmitCtx& c, u32 ctx_ptr) {
    c.b.op_local_set(LOCAL_TMP_A);
    c.b.op_i32_const((s32)ctx_ptr);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_store(ppc_off::PC);
}

// Emit fallback: inst_word + pc are i32 consts; calls WIMPORT_INTERP.
//
// B11: when GPR-local cache is active, dirty GPRs MUST be flushed to memory
// before the interpreter call (the interpreter reads ppc_state.gpr directly).
// AFTER the call, all GPR locals are invalidated because the interpreter
// may have written ppc_state.gpr — cached locals would be stale.
inline void emit_fallback(EmitCtx& c) {
    extern u32 g_ctx_ptr;
    emit_flush_dirty_gprs_impl(c, g_ctx_ptr);
    c.b.op_i32_const((s32)c.inst);
    c.b.op_i32_const((s32)c.pc);
    c.b.op_call(WIMPORT_INTERP);
    emit_invalidate_gpr_locals(c);
    c.used_fallback = true;
}

} // namespace bemental::powerpc
