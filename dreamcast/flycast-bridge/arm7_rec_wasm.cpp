// Lever-7 — ARM7 wasm dynarec backend (docs/lever-7-arm7-rec/TASKS.md).
//
// Task 3: real ArmOp -> wasm emitter. One WebAssembly module per ARM7 block
// (the SH4 per-block install path — instance spray is fine at ARM7 scale:
// the sound driver is KBs, block count is hundreds). Helpers
// (recompiler::interpret, MSR_do<0|1>, the four DoMemOp instances,
// CPUUpdateCPSR) are reached by call_indirect on the shared
// __indirect_function_table at their C function-pointer values — under
// emscripten a function pointer IS its wasmTable index, baked as a constant
// at emit time.
//
// Flag semantics are the INTERPRETER's, bit-for-bit (arm-new.h): carry and
// overflow use the exact ADDCARRY/SUBCARRY/ADDOVERFLOW/SUBOVERFLOW bit
// formulas, and the barrel shifter computes the true carry-out in every
// reg/imm shift form (the native arm64 backend approximates reg-shift carry
// by preserving C — we do not, so the from-load parity gate can compare the
// emitter against the interpreter arm and expect hash equality). Known
// non-exactness, shared with the native backends: a logical-op immediate
// whose encoding used a nonzero rotate but produced a value <= 255 gets
// C preserved instead of value[31] (decode bakes the rotated value and
// drops the rotate; assembler-canonical encodings never hit this — the
// parity gate would surface it as a hash divergence).
//
// v0 (task 2) survives as (a) the install-failure fallback and (b) the
// `?noarm7jit` / FLYCAST_ARM7JIT=0 arm — the parity baseline.
//
// Contract notes from the task-1/2 audits: EntryPoints[] holds real
// callable pointers; arm_mainloop/arm_compilecode are plain C functions;
// blocks return to the loop (same per-block cycles->fiq->dispatch order as
// the native mainloop); the block prologue debits CYCL_CNT by the decode's
// cycle total, FALLBACK ops self-debit inside interpret().

#include "build.h"

#if FEAT_AREC != DYNAREC_NONE

#include "types.h"
#include "hw/arm7/arm7.h"
#include "hw/arm7/arm7_rec.h"
#include "hw/aica/aica_if.h"

#include <emscripten.h>
#include <emscripten/threading.h>

#include "bementalJIT/wasm_module_builder.h"

#include <cstdlib>
#include <cstring>

// EM_JS-defined in rec_wasm.cpp; extern-C linkable across TUs. Returns the
// new wasmTable index for the module's "run" export, 0 on failure.
extern "C" int wasm_install_block(uintptr_t bytesPtr, int len, uint32_t vaddr);
extern "C" int wasm_dispatcher_get_last_error(char* dst, int max_len);

namespace aica::arm {

namespace recompiler {
// Defined in arm7_rec.cpp; no header declaration exists.
extern void (*EntryPoints[ARAM_SIZE_MAX / 4])();
// Patch 0011: end (exclusive) of the current block's source span.
extern u32 block_end_pc;
}

static_assert(sizeof(reg_pair) == 4, "arm_Reg element stride must be 4");

// ---------------------------------------------------------------------------
// Toggle: ?noarm7jit / FLYCAST_ARM7JIT=0 keeps the v0 interpret-runner as the
// "compiled" form — the parity/perf baseline arm.
// ---------------------------------------------------------------------------
static bool s_arm7jit_enabled = []{
    const char* e = std::getenv("FLYCAST_ARM7JIT");
    return !(e && e[0] == '0');
}();
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_arm7jit(int on) {
    s_arm7jit_enabled = !!on;
}

// Semantic self-test (?arm7selftest): at compile time, run each PURE
// ALU/branch block (no LDR/STR/MRS/MSR/FALLBACK — those have memory or
// helper side effects) both ways from a register snapshot — the emitted
// function, then an interpreter replay of the source span — and compare
// every register except CYCL_CNT (cycle models differ BY DESIGN between
// rec and interp; that is why from-load parity cannot gate rec-vs-interp)
// and RN_SCRATCH. Timing-independent: catches ALU/shifter/flag/branch
// emit bugs exactly. State is restored afterward, so the test is invisible
// to the run.
static bool s_arm7_selftest = []{
    const char* e = std::getenv("FLYCAST_ARM7SELFTEST");
    return e && e[0] == '1';
}();
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_arm7selftest(int on) {
    s_arm7_selftest = !!on;
}
static u32 s_selftest_blocks = 0, s_selftest_mismatch = 0;

// ---------------------------------------------------------------------------
// v0 runner (task 2) — interprets a block span under REC conventions.
// ---------------------------------------------------------------------------
static void arm7_v0_block()
{
    u32 pc = arm_Reg[R15_ARM_NEXT].I;
    for (int i = 0; i < 32; ++i) {
        const u32 opcd = *(u32*)&aica_ram[pc & ARAM_MASK];
        arm_Reg[R15_ARM_NEXT].I = pc + 4;   // frontend fallthrough convention
        arm_Reg[RN_PC].I = pc + 8;          // interpret() r15 contract
        recompiler::interpret(opcd);
        if (arm_Reg[R15_ARM_NEXT].I != pc + 4)
            return;                          // op set pc -> block end
        pc += 4;
    }
}

static void arm_compile_stub()
{
    recompiler::compile();
}

static void arm_mainloop_c(reg_pair* regs, void (*entrypoints[])())
{
    for (;;) {
        if ((int)regs[CYCL_CNT].I <= 0)
            return;
        if (regs[INTR_PEND].I) {
            CPUFiq();
            continue;
        }
        entrypoints[(regs[R15_ARM_NEXT].I & (ARAM_SIZE_MAX - 1)) / 4]();
    }
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------
namespace {

// Locals of the emitted () -> void block function.
constexpr u32 L_OP2   = 0;   // shifter operand value
constexpr u32 L_CARRY = 1;   // shifter carry-out (0/1)
constexpr u32 L_LHS   = 2;   // first ALU operand / mem address
constexpr u32 L_RES   = 3;   // ALU result
constexpr u32 L_FLAGS = 4;   // PSR flags word (N=31 Z=30 C=29 V=28)
constexpr u32 L_TMP   = 5;   // scratch (shift amount, shifted reg copy)
constexpr u32 NUM_LOCALS = 6;

// Type indices in the emitted module.
constexpr u32 T_VOID_VOID = 0;   // ()->void          run, CPUUpdateCPSR
constexpr u32 T_I32_VOID  = 1;   // (i32)->void       interpret, MSR_do
constexpr u32 T_I32X2_I32 = 2;   // (i32,i32)->i32    DoMemOp

constexpr u32 FLAG_N = 1u << 31, FLAG_Z = 1u << 30,
              FLAG_C = 1u << 29, FLAG_V = 1u << 28;

inline u32 reg_addr(int r) { return (u32)(uintptr_t)&arm_Reg[r].I; }

// Function-pointer -> wasmTable index (emscripten guarantee).
inline u32 tbl_idx(void* fn) { return (u32)(uintptr_t)fn; }

// How the shifter left the carry.
enum class CarryMode { Preserve, Const0, Const1, Dynamic };

class Arm7WasmEmitter {
public:
    explicit Arm7WasmEmitter(WasmModuleBuilder& b) : b(b) {}

    void emitBlock(const std::vector<ArmOp>& ops, u32 cycles)
    {
        // Prologue: CYCL_CNT -= cycles (unconditional, whole block —
        // native backends do the same; FALLBACK ops add their own on top
        // inside interpret()).
        b.op_i32_const(reg_addr(CYCL_CNT));
        b.op_i32_const(reg_addr(CYCL_CNT));
        b.op_i32_load(0);
        b.op_i32_const((s32)cycles);
        b.op_i32_sub();
        b.op_i32_store(0);

        for (const ArmOp& op : ops)
            emitOp(op);
        // endFuncBody() supplies the final `end`; falling off returns to
        // the C mainloop, which re-checks cycles/FIQ and re-dispatches.
    }

private:
    WasmModuleBuilder& b;

    void loadFlagsLocal()
    {
        b.op_i32_const(reg_addr(RN_PSR_FLAGS));
        b.op_i32_load(0);
        b.op_local_set(L_FLAGS);
    }

    void storeFlagsLocal()
    {
        b.op_i32_const(reg_addr(RN_PSR_FLAGS));
        b.op_local_get(L_FLAGS);
        b.op_i32_store(0);
    }

    void loadReg(int r) { b.op_i32_const(reg_addr(r)); b.op_i32_load(0); }

    // Stack in: value. Stores to arm_Reg[r]. (Address must precede value in
    // wasm stores, so this routes through L_TMP.)
    void storeRegFromStack(int r)
    {
        b.op_local_set(L_TMP);
        b.op_i32_const(reg_addr(r));
        b.op_local_get(L_TMP);
        b.op_i32_store(0);
    }

    // Leaves the condition predicate (i32 0/1) on the stack. L_FLAGS must
    // hold the current flags word.
    void emitCondPredicate(ArmOp::Condition cc)
    {
        auto bit = [&](u32 mask) {
            b.op_local_get(L_FLAGS);
            b.op_i32_const((s32)mask);
            b.op_i32_and();
        };
        switch (cc) {
        case ArmOp::EQ: bit(FLAG_Z); break;
        case ArmOp::NE: bit(FLAG_Z); b.op_i32_eqz(); break;
        case ArmOp::CS: bit(FLAG_C); break;
        case ArmOp::CC: bit(FLAG_C); b.op_i32_eqz(); break;
        case ArmOp::MI: bit(FLAG_N); break;
        case ArmOp::PL: bit(FLAG_N); b.op_i32_eqz(); break;
        case ArmOp::VS: bit(FLAG_V); break;
        case ArmOp::VC: bit(FLAG_V); b.op_i32_eqz(); break;
        case ArmOp::HI:               // C && !Z
            bit(FLAG_C); b.op_i32_eqz(); b.op_i32_eqz();
            bit(FLAG_Z); b.op_i32_eqz();
            b.op_i32_and();
            break;
        case ArmOp::LS:               // !C || Z
            bit(FLAG_C); b.op_i32_eqz();
            bit(FLAG_Z); b.op_i32_eqz(); b.op_i32_eqz();
            b.op_i32_or();
            break;
        case ArmOp::GE:               // N == V
            bit(FLAG_N); b.op_i32_eqz();
            bit(FLAG_V); b.op_i32_eqz();
            b.op_i32_eq();
            break;
        case ArmOp::LT:               // N != V
            bit(FLAG_N); b.op_i32_eqz();
            bit(FLAG_V); b.op_i32_eqz();
            b.op_i32_ne();
            break;
        case ArmOp::GT:               // !Z && (N == V)
            bit(FLAG_Z); b.op_i32_eqz();
            bit(FLAG_N); b.op_i32_eqz();
            bit(FLAG_V); b.op_i32_eqz();
            b.op_i32_eq();
            b.op_i32_and();
            break;
        case ArmOp::LE:               // Z || (N != V)
            bit(FLAG_Z); b.op_i32_eqz(); b.op_i32_eqz();
            bit(FLAG_N); b.op_i32_eqz();
            bit(FLAG_V); b.op_i32_eqz();
            b.op_i32_ne();
            b.op_i32_or();
            break;
        default:                      // AL/UC never get here
            b.op_i32_const(1);
            break;
        }
    }

    // Evaluate an operand into L_OP2. If wantCarry, the shifter carry-out
    // convention is the returned CarryMode (Dynamic => L_CARRY holds 0/1).
    // Reads L_FLAGS for RRX / reg-shift preserve cases.
    CarryMode emitShifterOperand(const ArmOp::Operand& a, bool wantCarry)
    {
        if (a.isImmediate()) {
            b.op_i32_const((s32)a.getImmediate());
            b.op_local_set(L_OP2);
            if (!wantCarry)
                return CarryMode::Preserve;
            if (a.getImmediate() > 255)
                return (a.getImmediate() >> 31) ? CarryMode::Const1
                                                : CarryMode::Const0;
            return CarryMode::Preserve;
        }
        const int rm = (int)a.getReg().armreg;
        if (a.shift_imm) {
            const u32 n = a.shift_value;
            switch (a.shift_type) {
            case ArmOp::LSL:
                if (n == 0) {                       // plain register
                    loadReg(rm);
                    b.op_local_set(L_OP2);
                    return CarryMode::Preserve;
                }
                loadReg(rm); b.op_local_set(L_TMP);
                if (wantCarry) {                    // C = v >> (32-n) & 1
                    b.op_local_get(L_TMP);
                    b.op_i32_const((s32)(32 - n));
                    b.op_i32_shr_u();
                    b.op_i32_const(1); b.op_i32_and();
                    b.op_local_set(L_CARRY);
                }
                b.op_local_get(L_TMP);
                b.op_i32_const((s32)n); b.op_i32_shl();
                b.op_local_set(L_OP2);
                return wantCarry ? CarryMode::Dynamic : CarryMode::Preserve;
            case ArmOp::LSR:
                loadReg(rm); b.op_local_set(L_TMP);
                if (n == 0) {                       // encodes LSR #32
                    if (wantCarry) {
                        b.op_local_get(L_TMP);
                        b.op_i32_const(31); b.op_i32_shr_u();
                        b.op_local_set(L_CARRY);
                    }
                    b.op_i32_const(0);
                    b.op_local_set(L_OP2);
                    return wantCarry ? CarryMode::Dynamic : CarryMode::Preserve;
                }
                if (wantCarry) {                    // C = v >> (n-1) & 1
                    b.op_local_get(L_TMP);
                    b.op_i32_const((s32)(n - 1)); b.op_i32_shr_u();
                    b.op_i32_const(1); b.op_i32_and();
                    b.op_local_set(L_CARRY);
                }
                b.op_local_get(L_TMP);
                b.op_i32_const((s32)n); b.op_i32_shr_u();
                b.op_local_set(L_OP2);
                return wantCarry ? CarryMode::Dynamic : CarryMode::Preserve;
            case ArmOp::ASR:
                loadReg(rm); b.op_local_set(L_TMP);
                if (n == 0) {                       // encodes ASR #32
                    if (wantCarry) {
                        b.op_local_get(L_TMP);
                        b.op_i32_const(31); b.op_i32_shr_u();
                        b.op_local_set(L_CARRY);
                    }
                    b.op_local_get(L_TMP);
                    b.op_i32_const(31); b.op_i32_shr_s();
                    b.op_local_set(L_OP2);
                    return wantCarry ? CarryMode::Dynamic : CarryMode::Preserve;
                }
                if (wantCarry) {
                    b.op_local_get(L_TMP);
                    b.op_i32_const((s32)(n - 1)); b.op_i32_shr_s();
                    b.op_i32_const(1); b.op_i32_and();
                    b.op_local_set(L_CARRY);
                }
                b.op_local_get(L_TMP);
                b.op_i32_const((s32)n); b.op_i32_shr_s();
                b.op_local_set(L_OP2);
                return wantCarry ? CarryMode::Dynamic : CarryMode::Preserve;
            case ArmOp::ROR:
                loadReg(rm); b.op_local_set(L_TMP);
                if (n == 0) {                       // RRX (reads C)
                    b.op_local_get(L_TMP);
                    b.op_i32_const(1); b.op_i32_and();
                    b.op_local_set(L_CARRY);        // carry-out = v & 1
                    b.op_local_get(L_TMP);
                    b.op_i32_const(1); b.op_i32_shr_u();
                    b.op_local_get(L_FLAGS);
                    b.op_i32_const((s32)FLAG_C); b.op_i32_and();
                    b.op_i32_const(0); b.op_i32_ne();   // Cin as 0/1
                    b.op_i32_const(31); b.op_i32_shl();
                    b.op_i32_or();
                    b.op_local_set(L_OP2);
                    return wantCarry ? CarryMode::Dynamic : CarryMode::Preserve;
                }
                if (wantCarry) {
                    b.op_local_get(L_TMP);
                    b.op_i32_const((s32)(n - 1)); b.op_i32_shr_u();
                    b.op_i32_const(1); b.op_i32_and();
                    b.op_local_set(L_CARRY);
                }
                b.op_local_get(L_TMP);
                b.op_i32_const((s32)n); b.op_i32_rotr();
                b.op_local_set(L_OP2);
                return wantCarry ? CarryMode::Dynamic : CarryMode::Preserve;
            default:
                break;
            }
            // Unreachable
            b.op_i32_const(0); b.op_local_set(L_OP2);
            return CarryMode::Preserve;
        }

        // ---- shift by register: amount = reg[rs] & 0xFF (runtime) ----
        // Carry is Dynamic in all cases; the s==0 branch loads the current
        // C so "preserve" is uniform.
        const int rs = (int)a.shift_reg.armreg;
        loadReg(rm); b.op_local_set(L_TMP);          // v
        loadReg(rs);
        b.op_i32_const(0xFF); b.op_i32_and();
        b.op_local_set(L_RES);                       // s (L_RES free here)

        // L_CARRY = Cin (the s==0 preserve default)
        b.op_local_get(L_FLAGS);
        b.op_i32_const((s32)FLAG_C); b.op_i32_and();
        b.op_i32_const(0); b.op_i32_ne();
        b.op_local_set(L_CARRY);

        auto s_ = [&]{ b.op_local_get(L_RES); };
        auto v_ = [&]{ b.op_local_get(L_TMP); };

        switch (a.shift_type) {
        case ArmOp::LSL:
            // s==0: val=v (C preserved). s<32: C=(v>>(32-s))&1, val=v<<s.
            // s==32: C=v&1, val=0. s>32: C=0, val=0.
            s_(); b.op_i32_eqz();
            b.op_if();
                v_(); b.op_local_set(L_OP2);
            b.op_else();
                s_(); b.op_i32_const(32); b.op_i32_lt_u();
                b.op_if();
                    v_(); b.op_i32_const(32); s_(); b.op_i32_sub();
                    b.op_i32_shr_u();
                    b.op_i32_const(1); b.op_i32_and();
                    b.op_local_set(L_CARRY);
                    v_(); s_(); b.op_i32_shl();
                    b.op_local_set(L_OP2);
                b.op_else();
                    s_(); b.op_i32_const(32); b.op_i32_eq();
                    b.op_if();
                        v_(); b.op_i32_const(1); b.op_i32_and();
                        b.op_local_set(L_CARRY);
                    b.op_else();
                        b.op_i32_const(0); b.op_local_set(L_CARRY);
                    b.op_end();
                    b.op_i32_const(0); b.op_local_set(L_OP2);
                b.op_end();
            b.op_end();
            break;
        case ArmOp::LSR:
            s_(); b.op_i32_eqz();
            b.op_if();
                v_(); b.op_local_set(L_OP2);
            b.op_else();
                s_(); b.op_i32_const(32); b.op_i32_lt_u();
                b.op_if();
                    v_(); s_(); b.op_i32_const(1); b.op_i32_sub();
                    b.op_i32_shr_u();
                    b.op_i32_const(1); b.op_i32_and();
                    b.op_local_set(L_CARRY);
                    v_(); s_(); b.op_i32_shr_u();
                    b.op_local_set(L_OP2);
                b.op_else();
                    s_(); b.op_i32_const(32); b.op_i32_eq();
                    b.op_if();
                        v_(); b.op_i32_const(31); b.op_i32_shr_u();
                        b.op_local_set(L_CARRY);
                    b.op_else();
                        b.op_i32_const(0); b.op_local_set(L_CARRY);
                    b.op_end();
                    b.op_i32_const(0); b.op_local_set(L_OP2);
                b.op_end();
            b.op_end();
            break;
        case ArmOp::ASR:
            // s==0: val=v (C preserved). s<32: C=(v>>s(s-1))&1, val=v>>s s.
            // s>=32: C = v>>31, val = sign(v).
            s_(); b.op_i32_eqz();
            b.op_if();
                v_(); b.op_local_set(L_OP2);
            b.op_else();
                s_(); b.op_i32_const(32); b.op_i32_lt_u();
                b.op_if();
                    v_(); s_(); b.op_i32_const(1); b.op_i32_sub();
                    b.op_i32_shr_s();
                    b.op_i32_const(1); b.op_i32_and();
                    b.op_local_set(L_CARRY);
                    v_(); s_(); b.op_i32_shr_s();
                    b.op_local_set(L_OP2);
                b.op_else();
                    v_(); b.op_i32_const(31); b.op_i32_shr_u();
                    b.op_local_set(L_CARRY);
                    v_(); b.op_i32_const(31); b.op_i32_shr_s();
                    b.op_local_set(L_OP2);
                b.op_end();
            b.op_end();
            break;
        case ArmOp::ROR:
            // s==0: val=v (C preserved). (s&31)==0: C=v>>31, val=v.
            // else: C=(v>>((s&31)-1))&1, val=rotr(v, s&31).
            s_(); b.op_i32_eqz();
            b.op_if();
                v_(); b.op_local_set(L_OP2);
            b.op_else();
                s_(); b.op_i32_const(31); b.op_i32_and();
                b.op_local_set(L_RES);              // s &= 31
                s_(); b.op_i32_eqz();
                b.op_if();
                    v_(); b.op_i32_const(31); b.op_i32_shr_u();
                    b.op_local_set(L_CARRY);
                    v_(); b.op_local_set(L_OP2);
                b.op_else();
                    v_(); s_(); b.op_i32_const(1); b.op_i32_sub();
                    b.op_i32_shr_u();
                    b.op_i32_const(1); b.op_i32_and();
                    b.op_local_set(L_CARRY);
                    v_(); s_(); b.op_i32_rotr();
                    b.op_local_set(L_OP2);
                b.op_end();
            b.op_end();
            break;
        default:
            b.op_i32_const(0); b.op_local_set(L_OP2);
            break;
        }
        return wantCarry ? CarryMode::Dynamic : CarryMode::Preserve;
    }

    // flags = (flags & keepMask) | newBits(stack contributions)
    // Emits: L_FLAGS = (L_FLAGS & keep) | <the values the caller pushes via
    // the callback>.
    template <typename F>
    void updateFlags(u32 keepMask, F&& pushNewBits)
    {
        b.op_local_get(L_FLAGS);
        b.op_i32_const((s32)keepMask);
        b.op_i32_and();
        pushNewBits();
        b.op_i32_or();
        b.op_local_set(L_FLAGS);
    }

    // Pushes N|Z bits computed from L_RES.
    void pushNZ()
    {
        b.op_local_get(L_RES);
        b.op_i32_const((s32)FLAG_N);
        b.op_i32_and();                       // N bit (res & 1<<31)
        b.op_local_get(L_RES);
        b.op_i32_eqz();
        b.op_i32_const(30); b.op_i32_shl();   // Z bit
        b.op_i32_or();
    }

    // interp bit formulas (arm-new.h). a=L_LHS, b_=L_OP2, c=L_RES.
    // ADDCARRY: ((a&b) | (a&~c) | (b&~c)) >> 31 -> C
    // ADDOVERFLOW: ((a&b&~c) | (~a&~b&c)) >> 31 -> V
    // SUBCARRY: ((a&~b) | (a&~c) | (~b&~c)) >> 31 -> C
    // SUBOVERFLOW: ((a&~b&~c) | (~a&b&c)) >> 31 -> V
    void pushArithCV(bool isSub, bool swapped)
    {
        const u32 A = swapped ? L_OP2 : L_LHS;
        const u32 B = swapped ? L_LHS : L_OP2;
        auto ga  = [&]{ b.op_local_get(A); };
        auto gb  = [&]{ b.op_local_get(B); };
        auto gnb = [&]{ b.op_local_get(B); b.op_i32_const(-1); b.op_i32_xor(); };
        auto gc  = [&]{ b.op_local_get(L_RES); };
        auto gna = [&]{ b.op_local_get(A); b.op_i32_const(-1); b.op_i32_xor(); };
        auto gnc = [&]{ b.op_local_get(L_RES); b.op_i32_const(-1); b.op_i32_xor(); };

        // C
        if (!isSub) {
            ga(); gb(); b.op_i32_and();
            ga(); gnc(); b.op_i32_and();
            b.op_i32_or();
            gb(); gnc(); b.op_i32_and();
            b.op_i32_or();
        } else {
            ga(); gnb(); b.op_i32_and();
            ga(); gnc(); b.op_i32_and();
            b.op_i32_or();
            gnb(); gnc(); b.op_i32_and();
            b.op_i32_or();
        }
        b.op_i32_const((s32)FLAG_N); b.op_i32_and();   // isolate bit31
        b.op_i32_const(2); b.op_i32_shr_u();           // -> bit29 (C)

        // V
        if (!isSub) {
            ga(); gb(); b.op_i32_and(); gnc(); b.op_i32_and();
            gna(); gnb(); b.op_i32_and(); gc(); b.op_i32_and();
            b.op_i32_or();
        } else {
            ga(); gnb(); b.op_i32_and(); gnc(); b.op_i32_and();
            gna(); gb(); b.op_i32_and(); gc(); b.op_i32_and();
            b.op_i32_or();
        }
        b.op_i32_const((s32)FLAG_N); b.op_i32_and();   // isolate bit31
        b.op_i32_const(3); b.op_i32_shr_u();           // -> bit28 (V)
        b.op_i32_or();
    }

    void emitDataProc(const ArmOp& op)
    {
        const bool sets = op.flags & ArmOp::OP_SETS_FLAGS;
        const bool logical = op.isLogicalOp();
        const bool isMovLike = (op.op_type == ArmOp::MOV || op.op_type == ArmOp::MVN);

        CarryMode cm = CarryMode::Preserve;
        if (isMovLike) {
            cm = emitShifterOperand(op.arg[0], sets && logical);
        } else {
            // lhs
            if (op.arg[0].isImmediate())
                b.op_i32_const((s32)op.arg[0].getImmediate());
            else
                loadReg((int)op.arg[0].getReg().armreg);
            b.op_local_set(L_LHS);
            cm = emitShifterOperand(op.arg[1], sets && logical);
        }

        // Compute result into L_RES.
        auto lhs = [&]{ b.op_local_get(L_LHS); };
        auto op2 = [&]{ b.op_local_get(L_OP2); };
        auto cin = [&]{          // (flags >> 29) & 1
            b.op_local_get(L_FLAGS);
            b.op_i32_const(29); b.op_i32_shr_u();
            b.op_i32_const(1); b.op_i32_and();
        };

        bool haveResult = true;
        bool isSub = false, swapped = false;
        switch (op.op_type) {
        case ArmOp::AND: case ArmOp::TST:
            lhs(); op2(); b.op_i32_and(); break;
        case ArmOp::EOR: case ArmOp::TEQ:
            lhs(); op2(); b.op_i32_xor(); break;
        case ArmOp::ORR:
            lhs(); op2(); b.op_i32_or(); break;
        case ArmOp::BIC:
            lhs(); op2(); b.op_i32_const(-1); b.op_i32_xor(); b.op_i32_and(); break;
        case ArmOp::MOV:
            op2(); break;
        case ArmOp::MVN:
            op2(); b.op_i32_const(-1); b.op_i32_xor(); break;
        case ArmOp::SUB: case ArmOp::CMP:
            lhs(); op2(); b.op_i32_sub(); isSub = true; break;
        case ArmOp::RSB:
            op2(); lhs(); b.op_i32_sub(); isSub = true; swapped = true; break;
        case ArmOp::ADD: case ArmOp::CMN:
            lhs(); op2(); b.op_i32_add(); break;
        case ArmOp::ADC:
            lhs(); op2(); b.op_i32_add(); cin(); b.op_i32_add(); break;
        case ArmOp::SBC:
            lhs(); op2(); b.op_i32_sub();
            cin(); b.op_i32_const(1); b.op_i32_xor();   // borrow = !C
            b.op_i32_sub();
            isSub = true; break;
        case ArmOp::RSC:
            op2(); lhs(); b.op_i32_sub();
            cin(); b.op_i32_const(1); b.op_i32_xor();
            b.op_i32_sub();
            isSub = true; swapped = true; break;
        default:
            haveResult = false; break;
        }
        if (!haveResult) return;
        b.op_local_set(L_RES);

        if (!op.isCompOp() && op.rd.isReg()) {
            b.op_i32_const(reg_addr((int)op.rd.getReg().armreg));
            b.op_local_get(L_RES);
            b.op_i32_store(0);
        }

        if (!sets)
            return;

        if (logical) {
            // N,Z from result; C per shifter; V untouched.
            switch (cm) {
            case CarryMode::Preserve:
                updateFlags(~(FLAG_N | FLAG_Z), [&]{ pushNZ(); });
                break;
            case CarryMode::Const0:
                updateFlags(~(FLAG_N | FLAG_Z | FLAG_C), [&]{ pushNZ(); });
                break;
            case CarryMode::Const1:
                updateFlags(~(FLAG_N | FLAG_Z | FLAG_C), [&]{
                    pushNZ();
                    b.op_i32_const((s32)FLAG_C); b.op_i32_or();
                });
                break;
            case CarryMode::Dynamic:
                updateFlags(~(FLAG_N | FLAG_Z | FLAG_C), [&]{
                    pushNZ();
                    b.op_local_get(L_CARRY);
                    b.op_i32_const(29); b.op_i32_shl();
                    b.op_i32_or();
                });
                break;
            }
        } else {
            // Arithmetic: all four flags fresh.
            updateFlags(0x0FFFFFFF, [&]{
                pushNZ();
                pushArithCV(isSub, swapped);
                b.op_i32_or();
            });
        }
    }

    void emitMemOp(const ArmOp& op)
    {
        // Address into L_LHS.
        if (op.arg[0].isImmediate())
            b.op_i32_const((s32)op.arg[0].getImmediate());
        else
            loadReg((int)op.arg[0].getReg().armreg);
        b.op_local_set(L_LHS);
        if (op.pre_index && !op.arg[1].isNone()) {
            emitShifterOperand(op.arg[1], false);
            b.op_local_get(L_LHS);
            b.op_local_get(L_OP2);
            if (op.add_offset) b.op_i32_add(); else b.op_i32_sub();
            b.op_local_set(L_LHS);
        }

        // DoMemOp(addr, data) -> value
        b.op_local_get(L_LHS);
        if (op.op_type == ArmOp::STR) {
            if (op.arg[2].isImmediate())
                b.op_i32_const((s32)op.arg[2].getImmediate());
            else
                loadReg((int)op.arg[2].getReg().armreg);
        } else {
            b.op_i32_const(0);
        }
        b.op_i32_const((s32)tbl_idx(
            recompiler::getMemOp(op.op_type == ArmOp::LDR, op.byte_xfer)));
        b.op_call_indirect(T_I32X2_I32, 0);

        if (op.op_type == ArmOp::LDR)
            storeRegFromStack((int)op.rd.getReg().armreg);
        else
            b.op_drop();
    }

    void emitBranch(const ArmOp& op)
    {
        b.op_i32_const(reg_addr(R15_ARM_NEXT));
        if (op.arg[0].isImmediate()) {
            b.op_i32_const((s32)op.arg[0].getImmediate());
        } else {
            loadReg((int)op.arg[0].getReg().armreg);
            b.op_i32_const((s32)0xfffffffc);
            b.op_i32_and();
        }
        b.op_i32_store(0);
    }

    void emitMRS(const ArmOp& op)
    {
        b.op_i32_const((s32)tbl_idx((void*)&CPUUpdateCPSR));
        b.op_call_indirect(T_VOID_VOID, 0);
        b.op_i32_const(reg_addr((int)op.rd.getReg().armreg));
        loadReg(op.spsr ? RN_SPSR : RN_CPSR);
        b.op_i32_store(0);
    }

    void emitMSR(const ArmOp& op)
    {
        if (op.arg[0].isImmediate())
            b.op_i32_const((s32)op.arg[0].getImmediate());
        else
            loadReg((int)op.arg[0].getReg().armreg);
        b.op_i32_const((s32)tbl_idx(op.spsr
            ? (void*)&recompiler::MSR_do<1>
            : (void*)&recompiler::MSR_do<0>));
        b.op_call_indirect(T_I32_VOID, 0);
    }

    void emitFallback(const ArmOp& op)
    {
        // No condition wrap, no flags marshaling — interpret() evaluates the
        // condition and works on the memory flags directly. (Our L_FLAGS is
        // reloaded at each op, so there is no stale-local hazard.)
        b.op_i32_const((s32)op.arg[0].getImmediate());
        b.op_i32_const((s32)tbl_idx((void*)&recompiler::interpret));
        b.op_call_indirect(T_I32_VOID, 0);
    }

    void emitOp(const ArmOp& op)
    {
        if (op.op_type == ArmOp::FALLBACK) {
            emitFallback(op);
            return;
        }

        // Flags word into L_FLAGS at every op — condition tests, RRX,
        // reg-shift preserve, ADC/SBC carry-in, and flag updates all read
        // it. One shared-memory load per op; stored back only when set.
        loadFlagsLocal();

        const bool wrapped = op.condition != ArmOp::AL;
        if (wrapped) {
            emitCondPredicate(op.condition);
            b.op_if();
        }

        if (op.op_type <= ArmOp::MVN)
            emitDataProc(op);
        else if (op.op_type <= ArmOp::STR)
            emitMemOp(op);
        else if (op.op_type <= ArmOp::BL)
            emitBranch(op);
        else if (op.op_type == ArmOp::MRS)
            emitMRS(op);
        else if (op.op_type == ArmOp::MSR)
            emitMSR(op);

        if (op.flags & ArmOp::OP_SETS_FLAGS)
            storeFlagsLocal();

        if (wrapped)
            b.op_end();
    }
};

std::vector<u8> build_arm7_block(const std::vector<ArmOp>& ops, u32 cycles)
{
    WasmModuleBuilder b;
    b.emitHeader();

    b.emitTypeSection(3);
    {
        const u8 i32t[]  = { WASM_TYPE_I32 };
        const u8 i32x2[] = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitFuncType(nullptr, 0, nullptr, 0);   // T_VOID_VOID
        b.emitFuncType(i32t, 1, nullptr, 0);      // T_I32_VOID
        b.emitFuncType(i32x2, 2, i32t, 1);        // T_I32X2_I32
    }
    b.endSection();

    // memory + the shared function table; helper calls go call_indirect on
    // constant table indices, so no function imports are needed. The
    // installer's import object is a superset — only declared imports bind.
    b.emitImportSection(2);
    b.emitImportMemory("env", "memory", 1);
    b.emitImportTable("env", "__indirect_function_table", 0);
    b.endSection();

    {
        const u32 idx[] = { T_VOID_VOID };
        b.emitFunctionSection(1, idx);
    }
    b.emitExportSection("run", 0);   // no func imports -> block fn is idx 0

    b.beginCodeSection(1);
    b.beginFuncBody();
    {
        const u32 counts[] = { NUM_LOCALS };
        const u8  types[]  = { WASM_TYPE_I32 };
        b.emitLocals(1, counts, types);
    }
    Arm7WasmEmitter(b).emitBlock(ops, cycles);
    b.endFuncBody();
    b.endSection();
    return b.getBytes();
}

} // anonymous namespace

// ---------------------------------------------------------------------------
// Semantic self-test (see the toggle above for scope and rationale).
// ---------------------------------------------------------------------------
static bool selftest_eligible(const std::vector<ArmOp>& ops)
{
    for (const ArmOp& op : ops)
        if (!(op.op_type <= ArmOp::MVN || op.op_type == ArmOp::B
              || op.op_type == ArmOp::BL))
            return false;
    return !ops.empty();
}

static void run_selftest(u32 pc, u32 end_pc, void (*fn)())
{
    reg_pair snap[RN_ARM_REG_COUNT], got[RN_ARM_REG_COUNT], want[RN_ARM_REG_COUNT];
    memcpy(snap, arm_Reg, sizeof(snap));

    fn();                                    // emitted block
    memcpy(got, arm_Reg, sizeof(got));

    memcpy(arm_Reg, snap, sizeof(snap));     // interpreter replay of the span
    for (u32 p = pc; p < end_pc; p += 4) {
        const u32 opcd = *(u32*)&aica_ram[p & ARAM_MASK];
        arm_Reg[R15_ARM_NEXT].I = p + 4;
        arm_Reg[RN_PC].I = p + 8;
        recompiler::interpret(opcd);
    }
    memcpy(want, arm_Reg, sizeof(want));

    memcpy(arm_Reg, snap, sizeof(snap));     // invisible to the real run

    ++s_selftest_blocks;
    for (int r = 0; r < RN_ARM_REG_COUNT; ++r) {
        if (r == CYCL_CNT || r == RN_SCRATCH)
            continue;                        // cycle models differ by design
        if (r == RN_PC)
            continue;                        // r15 is not live under REC
                                             // conventions: decode bakes
                                             // pc-relative constants and the
                                             // FALLBACK prefix materializes
                                             // it; the replay loop's per-op
                                             // r15 writes are an artifact.
        if (got[r].I != want[r].I) {
            if (++s_selftest_mismatch <= 8) {
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd:'print', txt:'[arm7st] MISMATCH pc=0x' +
                        ($0>>>0).toString(16) + ' reg=' + ($1|0) +
                        ' jit=0x' + ($2>>>0).toString(16) +
                        ' interp=0x' + ($3>>>0).toString(16)});
                }, (int)pc, r, (int)got[r].I, (int)want[r].I);
            }
        }
    }
    if ((s_selftest_blocks & 0x1F) == 0) {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd:'print', txt:'[arm7st] blocks=' + ($0|0) +
                ' mismatches=' + ($1|0)});
        }, (int)s_selftest_blocks, (int)s_selftest_mismatch);
    }
}

// ---------------------------------------------------------------------------
// Backend entry points
// ---------------------------------------------------------------------------
void arm7backend_compile(const std::vector<ArmOp>& block_ops, u32 cycles)
{
    const u32 pc = arm_Reg[R15_ARM_NEXT].I;
    const u32 slot = (pc & (ARAM_SIZE_MAX - 1)) / 4;

    if (s_arm7jit_enabled) {
        std::vector<u8> bytes = build_arm7_block(block_ops, cycles);
        const int idx = wasm_install_block(
            (uintptr_t)bytes.data(), (int)bytes.size(), pc);
        if (idx > 0) {
            static bool s_logged = false;
            if (!s_logged) {
                s_logged = true;
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd:'print', txt:'[arm7rec] emitter engaged, first block pc=0x' +
                        ($0>>>0).toString(16) + ' ops=' + ($1|0) + ' bytes=' + ($2|0)});
                }, (int)pc, (int)block_ops.size(), (int)bytes.size());
            }
            void (*fn)() = (void (*)())(uintptr_t)(u32)idx;
            recompiler::EntryPoints[slot] = fn;
            recompiler::advance((u32)bytes.size());   // honest cache pressure
            if (s_arm7_selftest && selftest_eligible(block_ops))
                run_selftest(pc, recompiler::block_end_pc, fn);
            return;
        }
        static int s_fail_log = 0;
        if (s_fail_log < 4) {
            ++s_fail_log;
            char err[256] = {0};
            wasm_dispatcher_get_last_error(err, sizeof(err));
            MAIN_THREAD_EM_ASM({
                var p = $1 >>> 0;
                var s = '';
                while (HEAPU8[p] !== 0 && s.length < 256) { s += String.fromCharCode(HEAPU8[p]); p++; }
                postMessage({cmd:'print', txt:'[arm7rec] install FAILED pc=0x' +
                    ($0>>>0).toString(16) + ' err="' + s + '" — v0 fallback'});
            }, (int)pc, (uintptr_t)err);
        }
        // fall through to the v0 runner
    }

    recompiler::EntryPoints[slot] = &arm7_v0_block;
}

void arm7backend_flush()
{
    arm_mainloop = &arm_mainloop_c;
    arm_compilecode = &arm_compile_stub;
}

} // namespace aica::arm

#endif // FEAT_AREC != DYNAREC_NONE
