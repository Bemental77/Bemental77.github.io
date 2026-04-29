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
#include "bementalCompiler/wasm_module_builder.h"
#include "bementalCompiler/types.h"

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
// Per-instruction emit context.
// ---------------------------------------------------------------------------
struct EmitCtx {
    WasmModuleBuilder& b;
    u32  pc;          // guest PC of this instruction
    u32  inst;        // raw instruction word
    bool block_end;   // emitter sets to true to terminate the basic block
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
std::vector<u8> build_block(u32 start_pc, const u32* insts, u32 count,
                            u32 ctx_ptr_const, u32 mem_pages = 0);

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
    // Dolphin's ConditionRegister uses an internal encoding where each CR
    // field is a u64 with: SO at bit 59, EQ ⇔ low 32 bits == 0, GT ⇔
    // (s64)cr_val > 0, LT at bit 62. The header (ConditionRegister.h) notes:
    // "sign-extending the result of an operation from 32 to 64 bits results
    //  in a 64 bit value that works as a CR value."
    //
    // So for arithmetic results (addic., or., etc.), we just write the i32
    // result as the low 32 bits and its arithmetic sign-extension as the
    // high 32 bits. Without this, every Rc=1 operation produced a wrong CR
    // value and any subsequent bne+/beq misbranched.
    c.b.op_local_tee(LOCAL_TMP_A);   // tee, save to A, leave on stack
    c.b.op_drop();
    // Store low 32 bits at cr.fields[0]
    c.b.op_i32_const((s32)ctx_ptr);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_store(ppc_off::cr_field(0));
    // Store high 32 bits at cr.fields[0] + 4 = sign-extension of value
    c.b.op_i32_const((s32)ctx_ptr);
    c.b.op_local_get(LOCAL_TMP_A);
    c.b.op_i32_const(31);
    c.b.op_i32_shr_s();
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
inline void emit_fallback(EmitCtx& c) {
    c.b.op_i32_const((s32)c.inst);
    c.b.op_i32_const((s32)c.pc);
    c.b.op_call(WIMPORT_INTERP);
}

} // namespace bemental::powerpc
