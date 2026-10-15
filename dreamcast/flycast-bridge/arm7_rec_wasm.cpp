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
#include "hw/arm7/arm_mem.h"   // armff: the same readMem/writeMem the blocks call
#include "serialize.h"         // armff DIAG check: aica::serialize round trip
#include <algorithm>
#include <vector>

#include <emscripten.h>
#include <emscripten/threading.h>

#include "bementalJIT/wasm_module_builder.h"

#include <cstdlib>
#include <cstring>

// EM_JS-defined in rec_wasm.cpp; extern-C linkable across TUs. Returns the
// new wasmTable index for the module's "run" export, 0 on failure.
extern "C" int wasm_install_block(uintptr_t bytesPtr, int len, uint32_t vaddr);
extern "C" int wasm_dispatcher_get_last_error(char* dst, int max_len);
extern "C" void flycast_jit_declare_park_arm(uint32_t pc);   // rec_wasm.cpp

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

// ARM7 sound-RAM accesses inline (2026-10-15). Every LDR/STR used to be a
// call_indirect into DoMemOp, which masks the address and, below 0x800000,
// just loads or stores sound RAM. emitMemOp now does that RAM arm itself and
// keeps the call for registers. PSO lobby, ?armtime=1, two interleaved
// pairs: 68.4 / 68.3 ms of ARM per guest second vs 75.2 / 74.4 with
// ?armmemfp=0 (the control). COMPILE-time: the toggle flushes the ARM cache.
// (Block-end chaining — each block calling EntryPoints[pc] itself instead of
// returning to the mainloop — was measured in the same set and bought
// nothing: 67.8 / 65.3 with it off. Not kept.)
static bool s_arm7memfp = true;   // sound-RAM loads/stores inline (emitMemOp); ?armmemfp=0 = control
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_armmemfp(int on) {
    if (s_arm7memfp == !!on) return;
    s_arm7memfp = !!on;
    recompiler::flush();
}

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

// ---------------------------------------------------------------------------
// ARM7 cycle histogram by block start pc (DIAG, ?armhist=A,B on the page).
// It is how the pure-spin drop was sized and rejected (2026-10-15): neither
// PSO's nor Gauntlet's sound driver has a store-free loop that repeats its
// register file inside one sample (dreamcast/docs/toaster-split/TASKS.md).
// ---------------------------------------------------------------------------
static u32* s_armhist = nullptr;   // ARAM_SIZE_MAX/4 counters, allocated on demand
static void armhist_print()
{
    if (!s_armhist) return;
    const u32 N = ARAM_SIZE_MAX / 4;
    u64 tot = 0; for (u32 i = 0; i < N; ++i) tot += s_armhist[i];
    u32 top[16] = {0}; u32 val[16] = {0};
    for (u32 i = 0; i < N; ++i) {
        const u32 v = s_armhist[i]; if (v <= val[15]) continue;
        int k = 15; while (k > 0 && val[k - 1] < v) { val[k] = val[k - 1]; top[k] = top[k - 1]; --k; }
        val[k] = v; top[k] = i;
    }
    for (int k = 0; k < 16 && val[k]; ++k) {
        const u32 pc = top[k] * 4;
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[armhist] #' + $0 + ' pc=0x' + ($1>>>0).toString(16) + ' ' +
            (($2|0) / 100).toFixed(2) + '% of ' + ($3>>>0) + 'K cyc'}); }, k, (int)pc, (int)(tot ? (u64)val[k] * 10000 / tot : 0), (int)(u32)(tot / 1000));
    }
    for (int k = 0; k < 4 && val[k]; ++k) {   // code words for an offline disassembly
        const u32 pc = (top[k] * 4) & ARAM_MASK, base = pc >= 64 ? pc - 64 : 0;
        char buf[24 * 9 + 1]; buf[0] = 0; char* o = buf;
        for (int w = 0; w < 24; ++w) o += snprintf(o, 10, "%08x ", *(u32*)&aica_ram[(base + w * 4) & ARAM_MASK]);
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[armcode] base=0x' + ($0>>>0).toString(16) + ' ' + UTF8ToString($1)}); }, (int)base, buf);
    }
    memset(s_armhist, 0, N * 4);
}
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_armhist(int on) {
    if (on && !s_armhist) s_armhist = (u32*)calloc(ARAM_SIZE_MAX / 4, 4);
    else if (!on && s_armhist) { armhist_print(); free(s_armhist); s_armhist = nullptr; }
}
// DIAG (?armtime=1): wall time inside the ARM mainloop per guest second,
// printed every 5 guest seconds of samples. Two clock reads a sample.
static bool s_armtime = false;
static double s_armtime_ms = 0;
static u32 s_armtime_n = 0;
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_armtime(int on) { s_armtime = !!on; s_armtime_ms = 0; s_armtime_n = 0; }
// ---------------------------------------------------------------------------
// PSO'S SOUND-DRIVER LOOP, BLOCK BY BLOCK IN C (armff, 2026-10-15). The ARM7
// driver's main loop (0x194..0x1e0) never waits. Each pass bumps the monitored-
// channel counter and writes it to MSLC (0xac0), checks the SH4->ARM command
// queue (0x2100), pops its own queue four times (0x1cec / 0xd60), updates ONE
// channel's status from the monitor registers (0x93c, groups A/B/C), and checks
// two flags (0x1c0 / 0x1d8): 31 blocks, 11 of them a single bl and 8 a return.
// A pass is ~840 decode cycles, longer than a sample's 512, and the loop is
// ~26% of the toaster's emulation (?armtime=1), most of it mainloop dispatch.
//
// armff_go runs those 27 blocks in C, starting at whichever of them the ARM is
// at, exactly as the mainloop would: before each block the cycle counter must
// be positive and no FIQ pending, the block debits its decode cycles, and it
// stops at the first pc that is not one of them (a full queue, a set flag, an
// active channel) or at the end of the sample. Each block is modelled for every
// input (both branch outcomes, its conditional ops, its flags as the emitter
// computes them), and it runs only while EntryPoints still holds the block that
// arm7backend_compile built from the golden bytes (learned with its cycles).
// Accesses go through the same arm::readMem/writeMem the blocks call, in
// program order (the MSLC write, the 0x2810 read that clears the loop flag,
// the 0x2814 read). The MLA in each group path is a FALLBACK op: interpret()
// debits 6 + 3 and leaves r15 = its pc + 8. ?armff=0 is the control; ?armff=2 is
// a DIAG check: at every 64th entry it serializes the AICA (ARM7 registers,
// sound RAM, AICA registers, channels), runs the blocks in C, serializes the
// result, restores the first state, lets the compiled blocks run the same
// number of blocks and compares the two serializations byte for byte.
// ---------------------------------------------------------------------------
static u32 s_armff = 1;
static u32 s_af_runs = 0, s_af_blocks = 0, s_af_chk_ok = 0, s_af_chk_bad = 0, s_af_chk_lost = 0;
static const u32 AF_GOLD[][2] = {
{0x194,0xeb000249}, {0x198,0xeb0007d8}, {0x19c,0xeb0006d2}, {0x1a0,0xeb0002ee}, {0x1a4,0xeb0006d0}, {0x1a8,0xeb0002ec},
{0x1ac,0xeb0006ce}, {0x1b0,0xeb0002ea}, {0x1b4,0xeb0006cc}, {0x1b8,0xeb0002e8}, {0x1bc,0xeb0001de}, {0x1c0,0xe5df9062},
{0x1c4,0xe31900ff}, {0x1c8,0x0a000002}, {0x1cc,0x13a09000}, {0x1d0,0xe5cf9052}, {0x1d4,0xeaffffee}, {0x1d8,0xe5df9048},
{0x1dc,0xe31900ff}, {0x1e0,0x0affffeb}, {0x93c,0xe3a05801}, {0x940,0xe5df0194}, {0x944,0xe59f1364}, {0x948,0xe5d11000},
{0x94c,0xe59f23a8}, {0x950,0xe5d22000}, {0x954,0xe0823001}, {0x958,0xe1500003}, {0x95c,0x5a000039}, {0x960,0xe1500001},
{0x964,0x5a000019}, {0x968,0xe3a01040}, {0x96c,0xe3a02801}, {0x970,0xe0252190}, {0x974,0xe59f83c8}, {0x978,0xe5980000},
{0x97c,0xe2104902}, {0x980,0x0a000002}, {0x984,0xe5954035}, {0x988,0xe31400ff}, {0x98c,0x15c5402b}, {0x990,0xe1a036a0},
{0x994,0xe3100c1f}, {0x998,0x13a000ff}, {0x99c,0xe20000ff}, {0x9a0,0xe22000ff}, {0x9a4,0xe2033003}, {0x9a8,0xe2333003},
{0x9ac,0x13a000ff}, {0x9b0,0xe5c50003}, {0x9b4,0xe5950000}, {0x9b8,0xe3d00000}, {0x9bc,0x11a0f00e}, {0x9c0,0xe5df1114},
{0x9c4,0xe59f537c}, {0x9c8,0xe7c50001}, {0x9cc,0xe1a0f00e}, {0x9d0,0xe0400001}, {0x9d4,0xe3a02b4a}, {0x9d8,0xe3a01040},
{0x9dc,0xe0252190}, {0x9e0,0xe59f835c}, {0x9e4,0xe5980000}, {0x9e8,0xe5952018}, {0x9ec,0xe2100902}, {0x9f0,0x12822001},
{0x9f4,0x15852018}, {0x9f8,0xe59f834c}, {0x9fc,0xe5980000}, {0xa00,0xe5d51000}, {0xa04,0xe3110001}, {0xa08,0x01a0f00e},
{0xa0c,0xe585001c}, {0xa10,0xe1a04000}, {0xa14,0xe5d5103d}, {0xa18,0xe28f2000}, {0xa1c,0xe082f001}, {0xa20,0xe1a04084},
{0xa24,0xea000001}, {0xa28,0xe1a00000}, {0xa2c,0xe1a040a4}, {0xa30,0xe5854034}, {0xa34,0xe5951018}, {0xa38,0xe595202c},
{0xa3c,0xe0200291}, {0xa40,0xe5850020}, {0xa44,0xe1a0f00e}, {0xa48,0xe0400003}, {0xa4c,0xe3a02b4e}, {0xa50,0xe3a01040},
{0xa54,0xe0252190}, {0xa58,0xe59f82e4}, {0xa5c,0xe5980000}, {0xa60,0xe5951018}, {0xa64,0xe2100902}, {0xa68,0x12811001},
{0xa6c,0x15851018}, {0xa70,0xe59f82d4}, {0xa74,0xe5980000}, {0xa78,0xe5d51000}, {0xa7c,0xe3110001}, {0xa80,0x01a0f00e},
{0xa84,0xe585001c}, {0xa88,0xe1a04000}, {0xa8c,0xe5d5103d}, {0xa90,0xe28f2000}, {0xa94,0xe082f001}, {0xa98,0xe1a04084},
{0xa9c,0xea000001}, {0xaa0,0xe1a00000}, {0xaa4,0xe1a040a4}, {0xaa8,0xe5854034}, {0xaac,0xe5951018}, {0xab0,0xe5952024},
{0xab4,0xe0200291}, {0xab8,0xe5850020}, {0xabc,0xe1a0f00e}, {0xac0,0xe5df1014}, {0xac4,0xe2811001}, {0xac8,0xe201103f},
{0xacc,0xe59f827c}, {0xad0,0xe5c81000}, {0xad4,0xe5cf1000}, {0xad8,0xe1a0f00e}, {0xd60,0xe1b01001}, {0xd64,0x01a0f00e},
{0x1cec,0xe3a00a0b}, {0x1cf0,0xe3a03a12}, {0x1cf4,0xe5931000}, {0x1cf8,0xe51f30c4}, {0x1cfc,0xe5932000}, {0x1d00,0xe1510002},
{0x1d04,0x03a01000}, {0x1d08,0x0a000005}, {0x1d0c,0xe0800002}, {0x1d10,0xe5901000}, {0x1d14,0xe2822004}, {0x1d18,0xe59f4008},
{0x1d1c,0xe0022004}, {0x1d20,0xe5832000}, {0x1d24,0xe1a0f00e}, {0x2100,0xe3a00a15}, {0x2104,0xe59f1058}, {0x2108,0xe5911000},
{0x210c,0xe59f3054}, {0x2110,0xe5932000}, {0x2114,0xe1510002}, {0x2118,0x0a00000b}, {0x211c,0xe7901002}, {0x2120,0xe59f0028},
{0x2124,0xe2822004}, {0x2128,0xe0022000}, {0x212c,0xe5832000}, {0x2130,0xe3a02a0b}, {0x2134,0xe3a03a12}, {0x2138,0xe5934000},
{0x213c,0xe7821004}, {0x2140,0xe2844004}, {0x2144,0xe0044000}, {0x2148,0xe5834000}, {0x214c,0xe1a0f00e}, {0xcb0,0x00012060},
{0xcfc,0x00012061}, {0xd44,0x00802810}, {0xd48,0x00012020}, {0xd4c,0x00802814}, {0xd50,0x0080280d}, {0x1c3c,0x00012004},
{0x2164,0x0001242c}, {0x2168,0x00012428} };
static constexpr u32 AF_N = sizeof(AF_GOLD) / sizeof(AF_GOLD[0]);
static constexpr u32 AF_NLIT = 9;   // the last 9 are literal-pool words the blocks load at run time
static inline u32 af_w(u32 a) { return *(u32*)&aica_ram[a & ARAM_MASK & ~3u]; }
static inline u8 af_b(u32 a) { return aica_ram[a & ARAM_MASK]; }
static bool af_golden_ok() {
    for (u32 i = 0; i < AF_N; i++) if (af_w(AF_GOLD[i][0]) != AF_GOLD[i][1]) return false;
    return true;
}
static bool af_lits_ok() {
    for (u32 i = AF_N - AF_NLIT; i < AF_N; i++) if (af_w(AF_GOLD[i][0]) != AF_GOLD[i][1]) return false;
    return true;
}
enum { B194, B198, B19C, B1A0, B1A4, B1A8, B1AC, B1B0, B1B4, B1B8, B1BC, BAC0, B2100, B214C, B1CEC, B1D24, BD60,
       B93C, B960, B968, B984, B990, B9C0, B9D0, BA48, B1C0, B1D8, AF_NB };
static const u32 AF_BLK[AF_NB] = { 0x194, 0x198, 0x19c, 0x1a0, 0x1a4, 0x1a8, 0x1ac, 0x1b0, 0x1b4, 0x1b8, 0x1bc,
                                   0xac0, 0x2100, 0x214c, 0x1cec, 0x1d24, 0xd60, 0x93c, 0x960, 0x968, 0x984, 0x990, 0x9c0,
                                   0x9d0, 0xa48, 0x1c0, 0x1d8 };
static constexpr u32 AF_IDXN = 0x2200 / 4;
static u8 s_af_idx[AF_IDXN];   // pc/4 -> block index + 1 (0 = not one of them)
static void (*s_af_fn[AF_NB])() = {};
static u32 s_af_cyc[AF_NB] = {};
static void af_init_idx() {
    static bool done = false; if (done) return; done = true;
    for (u32 i = 0; i < AF_NB; i++) s_af_idx[AF_BLK[i] / 4] = (u8)(i + 1);
}
// Which modelled blocks are live: recomputed when an EntryPoints slot may have
// changed (any compile, any flush), so the per-block test is one bit.
static u32 s_af_epoch = 1, s_af_mask_epoch = 0, s_af_mask = 0;
static inline u32 af_live_mask() {
    if (s_af_mask_epoch != s_af_epoch) {
        u32 m = 0;
        for (u32 i = 0; i < AF_NB; i++)
            if (s_af_fn[i] && recompiler::EntryPoints[AF_BLK[i] / 4] == s_af_fn[i]) m |= 1u << i;
        s_af_mask = m; s_af_mask_epoch = s_af_epoch;
    }
    return s_af_mask;
}
static void armff_learn(u32 pc, void (*fn)(), u32 cycles) {
    ++s_af_epoch;
    af_init_idx();
    if (pc >= 0x2200 || (pc & 3) || !s_af_idx[pc / 4]) return;
    const u32 i = s_af_idx[pc / 4] - 1;
    const bool ok = af_golden_ok();
    s_af_fn[i] = ok ? fn : nullptr; s_af_cyc[i] = ok ? cycles : 0;
}
static void armff_forget() { ++s_af_epoch; for (u32 i = 0; i < AF_NB; i++) { s_af_fn[i] = nullptr; s_af_cyc[i] = 0; } }
static constexpr u32 AF_MLA = 9;   // interpret(): 6 + 3 (multiplier 0x40 < 0x100)
static constexpr u32 FN = 1u << 31, FZ = 1u << 30, FC = 1u << 29, FV = 1u << 28;
static inline u32 af_cmp(u32 a, u32 b, u32 fl) {
    const u32 r = a - b;
    fl &= ~(FN | FZ | FC | FV);
    if (r >> 31) fl |= FN;
    if (r == 0) fl |= FZ;
    if (a >= b) fl |= FC;
    if (((a ^ b) & (a ^ r)) >> 31) fl |= FV;
    return fl;
}
static inline u32 af_nz(u32 v, u32 fl) { fl &= ~(FN | FZ); if (v >> 31) fl |= FN; if (!v) fl |= FZ; return fl; }   // logical, C/V kept
// Run modelled blocks from the current pc; returns how many ran.
static u32 armff_go(reg_pair* regs) {
    if (!af_lits_ok()) return 0;
    const u32 live = af_live_mask();
    u32 r[16]; for (int i = 0; i < 16; i++) r[i] = regs[i].I;
    u32 fl = regs[RN_PSR_FLAGS].I, pc = regs[R15_ARM_NEXT].I;
    s32 cc = (s32)regs[CYCL_CNT].I;
    u32 n = 0;
    for (;;) {
        if (cc <= 0 || regs[INTR_PEND].I) break;
        if (pc >= 0x2200 || (pc & 3) || !s_af_idx[pc / 4]) break;
        const u32 i = s_af_idx[pc / 4] - 1;
        if (!((live >> i) & 1u)) break;
        cc -= (s32)s_af_cyc[i];
        u32 nx;
        switch (i) {
        case B194: case B198: case B19C: case B1A0: case B1A4: case B1A8: case B1AC: case B1B0: case B1B4: case B1B8: case B1BC: {
            static const u32 T[11] = { 0xac0, 0x2100, 0x1cec, 0xd60, 0x1cec, 0xd60, 0x1cec, 0xd60, 0x1cec, 0xd60, 0x93c };
            r[14] = pc + 4; nx = T[i - B194]; break; }
        case BAC0:
            r[1] = (af_b(0xadc) + 1u) & 0x3fu;
            r[8] = af_w(0xd50);
            writeMem<u8>(r[8], (u8)r[1]);
            writeMem<u8>(0xadc, (u8)r[1]);
            nx = r[14]; break;
        case B2100:
            r[0] = 0x15000; r[1] = readMem<u32>(af_w(0x2164)); r[3] = af_w(0x2168); r[2] = readMem<u32>(r[3]);
            fl = af_cmp(r[1], r[2], fl);
            nx = (fl & FZ) ? 0x214c : 0x211c; break;
        case B214C: case B1D24:
            nx = r[14]; break;
        case B1CEC:
            r[0] = 0xb000; r[3] = 0x12000; r[1] = readMem<u32>(r[3]); r[3] = af_w(0x1c3c); r[2] = readMem<u32>(r[3]);
            fl = af_cmp(r[1], r[2], fl);
            if (fl & FZ) r[1] = 0;
            nx = (fl & FZ) ? 0x1d24 : 0x1d0c; break;
        case BD60:
            fl = af_nz(r[1], fl);
            nx = (fl & FZ) ? r[14] : 0xd68; break;
        case B93C:
            r[5] = 0x10000; r[0] = readMem<u8>(0xadc);
            r[1] = readMem<u8>(af_w(0xcb0)); r[2] = readMem<u8>(af_w(0xcfc));
            r[3] = r[2] + r[1];
            fl = af_cmp(r[0], r[3], fl);
            nx = (fl & FN) ? 0x960 : 0xa48; break;
        case B960:
            fl = af_cmp(r[0], r[1], fl);
            nx = (fl & FN) ? 0x968 : 0x9d0; break;
        case B968:
            r[1] = 0x40; r[2] = 0x10000;
            r[15] = 0x978; r[5] = r[0] * r[1] + r[2]; cc -= (s32)AF_MLA;
            r[8] = af_w(0xd44); r[0] = readMem<u32>(r[8]);
            r[4] = r[0] & 0x8000u;
            fl = (fl & ~(FN | FZ | FC)) | (r[4] ? 0u : FZ);
            nx = (fl & FZ) ? 0x990 : 0x984; break;
        case B984: case B990:
            if (i == B984) {
                r[4] = readMem<u32>(r[5] + 0x35);
                fl = (fl & ~(FN | FZ)) | ((r[4] & 0xffu) ? 0u : FZ);
                if (!(fl & FZ)) writeMem<u8>(r[5] + 0x2b, (u8)r[4]);
            }
            r[3] = r[0] >> 13;
            fl = (fl & ~(FN | FZ | FC)) | ((r[0] & 0x1f00u) ? 0u : FZ);
            if (!(fl & FZ)) r[0] = 0xff;
            r[0] &= 0xffu; r[0] ^= 0xffu; r[3] &= 3u; r[3] ^= 3u;
            fl = af_nz(r[3], fl);
            if (!(fl & FZ)) r[0] = 0xff;
            writeMem<u8>(r[5] + 3, (u8)r[0]);
            r[0] = readMem<u32>(r[5]);
            fl = af_nz(r[0], fl);
            nx = (fl & FZ) ? 0x9c0 : r[14]; break;
        case B9C0:
            r[1] = readMem<u8>(0xadc); r[5] = af_w(0xd48);
            writeMem<u8>(r[5] + r[1], (u8)r[0]);
            nx = r[14]; break;
        case B9D0: case BA48: {
            const bool b = i == B9D0;
            r[0] = b ? r[0] - r[1] : r[0] - r[3];
            r[2] = b ? 0x12800 : 0x13800; r[1] = 0x40;
            r[15] = b ? 0x9e4 : 0xa5c; r[5] = r[0] * r[1] + r[2]; cc -= (s32)AF_MLA;
            r[8] = af_w(0xd44); r[0] = readMem<u32>(r[8]);
            u32& cnt = b ? r[2] : r[1];
            cnt = readMem<u32>(r[5] + 0x18);
            r[0] &= 0x8000u;
            fl = (fl & ~(FN | FZ | FC)) | (r[0] ? 0u : FZ);
            if (!(fl & FZ)) { cnt += 1; writeMem<u32>(r[5] + 0x18, cnt); }
            r[8] = af_w(0xd4c); r[0] = readMem<u32>(r[8]);
            r[1] = readMem<u8>(r[5]);
            fl = (fl & ~(FN | FZ)) | ((r[1] & 1u) ? 0u : FZ);
            nx = (fl & FZ) ? r[14] : (b ? 0xa0c : 0xa84); break; }
        case B1C0:
            r[9] = readMem<u8>(0x22a);
            fl = af_nz(r[9] & 0xffu, fl);
            nx = (fl & FZ) ? 0x1d8 : 0x1cc; break;
        case B1D8:
            r[9] = readMem<u8>(0x228);
            fl = af_nz(r[9] & 0xffu, fl);
            nx = (fl & FZ) ? 0x194 : 0x1e4; break;
        default: nx = pc; break;
        }
        pc = nx; ++n;
    }
    if (!n) return 0;
    for (int i = 0; i < 16; i++) regs[i].I = r[i];
    regs[RN_PSR_FLAGS].I = fl; regs[CYCL_CNT].I = (u32)cc; regs[R15_ARM_NEXT].I = pc;
    return n;
}
// DIAG check state
static std::vector<u8> s_af_s0, s_af_s1, s_af_s2;
static struct { bool on; u32 left; } s_af_chk = {};
static u32 s_af_entries = 0;
static size_t af_ser(std::vector<u8>& v) {
    Serializer dry; aica::serialize(dry);
    v.resize(dry.size());
    Serializer s(v.data(), v.size()); aica::serialize(s);
    return s.size();
}
static bool armff_try(reg_pair* regs) {
    if (s_armff == 2) {
        if (s_af_chk.on || (++s_af_entries & 63u)) return false;
        af_ser(s_af_s0);
        const u32 n = armff_go(regs);
        if (!n) return false;
        af_ser(s_af_s1);
        { Deserializer d(s_af_s0.data(), s_af_s0.size()); aica::deserialize(d); }
        s_af_chk.on = true; s_af_chk.left = n;
        return false;                                                      // the compiled blocks run the same n blocks
    }
    const u32 n = armff_go(regs);
    if (!n) return false;
    ++s_af_runs; s_af_blocks += n;
    if ((s_af_runs & 262143u) == 1u)
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[armff] runs=' + ($0>>>0) + ' blocks=' + ($1>>>0)}); }, (int)s_af_runs, (int)s_af_blocks);
    return true;
}
// After each compiled block while a check is in flight.
static void armff_check_step() {
    if (--s_af_chk.left) return;
    s_af_chk.on = false;
    af_ser(s_af_s2);
    size_t bad = (size_t)-1;
    if (s_af_s1.size() != s_af_s2.size()) bad = 0;
    else for (size_t i = 0; i < s_af_s1.size(); i++) if (s_af_s1[i] != s_af_s2[i]) { bad = i; break; }
    if (bad == (size_t)-1) {
        if ((++s_af_chk_ok & 1023u) == 1u)
            MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[armff-check] ok=' + ($0>>>0) + ' bad=' + ($1>>>0) + ' lost=' + ($2>>>0)}); },
                               (int)s_af_chk_ok, (int)s_af_chk_bad, (int)s_af_chk_lost);
        return;
    }
    if (++s_af_chk_bad <= 8)
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[armff-check] MISMATCH #' + ($0>>>0) + ' at byte ' + ($1>>>0) + ' of ' + ($2>>>0) +
                             ' c=' + ($3>>>0).toString(16) + ' real=' + ($4>>>0).toString(16)}); },
                           (int)s_af_chk_bad, (int)bad, (int)s_af_s1.size(),
                           bad < s_af_s1.size() ? (int)s_af_s1[bad] : -1, bad < s_af_s2.size() ? (int)s_af_s2[bad] : -1);
}
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_armff(int on) { s_armff = (u32)(on < 0 ? 0 : on > 2 ? 2 : on); s_af_chk.on = false; }
extern "C" EMSCRIPTEN_KEEPALIVE u32 flycast_armff_stat(int i) {
    switch (i) { case 0: return s_af_runs; case 1: return s_af_blocks; case 2: return 0;
                 case 3: return s_af_chk_ok; case 4: return s_af_chk_bad; case 5: return s_af_chk_lost; }
    if (i >= 18 && i < 18 + (int)AF_NB) return s_af_fn[i - 18] ? s_af_cyc[i - 18] : 0xffffffffu;
    return 0;
}

static void arm_mainloop_run(reg_pair* regs, void (*entrypoints[])());
static void arm_mainloop_c(reg_pair* regs, void (*entrypoints[])())
{
    if (!s_armtime) { arm_mainloop_run(regs, entrypoints); return; }
    const double t0 = emscripten_get_now();
    arm_mainloop_run(regs, entrypoints);
    s_armtime_ms += emscripten_get_now() - t0;
    if (++s_armtime_n == 5 * 44100) {
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[armtime] arm=' + ($0).toFixed(1) + ' ms per guest second'}); },
                           s_armtime_ms / 5.0);
        s_armtime_ms = 0; s_armtime_n = 0;
    }
}
static void arm_mainloop_run(reg_pair* regs, void (*entrypoints[])())
{
    for (;;) {
        if ((int)regs[CYCL_CNT].I <= 0) {
            if (s_af_chk.on) { s_af_chk.on = false; ++s_af_chk_lost; }   // armff DIAG: the sample ended first
            return;
        }
        if (regs[INTR_PEND].I) {
            CPUFiq();
            continue;
        }
        const u32 pc = regs[R15_ARM_NEXT].I;
        if (s_armff && pc < 0x2200u && s_af_idx[pc >> 2] && armff_try(regs)) continue;   // the driver loop in C (armff)
        void (*fn)() = entrypoints[(pc & (ARAM_SIZE_MAX - 1)) / 4];
        if (s_af_chk.on) { fn(); armff_check_step(); continue; }   // armff DIAG: count the compiled blocks
        if (s_armhist) {
            const int c0 = (int)regs[CYCL_CNT].I;
            fn();
            s_armhist[(pc & (ARAM_SIZE_MAX - 1)) >> 2] += (u32)(c0 - (int)regs[CYCL_CNT].I);
            continue;
        }
        fn();
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

        const bool load = op.op_type == ArmOp::LDR;
        if (s_arm7memfp) {
            // Sound RAM inline (?armmemfp=0 is the control): readMem/writeMem's
            // own RAM arm (arm_mem.h), same address arithmetic, same unaligned
            // word rotation. Registers (addr bit 23 set) keep the C call.
            b.op_local_get(L_LHS);
            b.op_i32_const(0x00800000);
            b.op_i32_and();
            b.op_i32_eqz();
            b.op_if(load ? WASM_TYPE_I32 : 0x40);
              // ptr = aica_ram.data + (addr & (ARAM_MASK - (size - 1)))
              b.op_i32_const((s32)(u32)(uintptr_t)&aica_ram);   // RamRegion's first member is its data pointer
              b.op_i32_load(0);
              b.op_i32_const((s32)(u32)(uintptr_t)&settings.platform.aram_mask);
              b.op_i32_load(0);
              b.op_i32_const(op.byte_xfer ? 0 : 3);
              b.op_i32_sub();
              b.op_local_get(L_LHS);
              b.op_i32_and();
              b.op_i32_add();
              if (load) {
                  if (op.byte_xfer) {
                      b.op_i32_load8_u(0);
                  } else {
                      b.op_i32_load(0, 0);
                      b.op_local_get(L_LHS);
                      b.op_i32_const(3);
                      b.op_i32_and();
                      b.op_i32_const(3);
                      b.op_i32_shl();
                      b.op_i32_rotr();
                  }
              } else {
                  if (op.arg[2].isImmediate())
                      b.op_i32_const((s32)op.arg[2].getImmediate());
                  else
                      loadReg((int)op.arg[2].getReg().armreg);
                  if (op.byte_xfer) b.op_i32_store8(0); else b.op_i32_store(0, 0);
              }
            b.op_else();
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
        if (!load) b.op_drop();
        if (s_arm7memfp) b.op_end();

        if (load)
            storeRegFromStack((int)op.rd.getReg().armreg);
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
    ++s_af_epoch;   // armff: an EntryPoints slot is about to change
    const u32 pc = arm_Reg[R15_ARM_NEXT].I;
    const u32 slot = (pc & (ARAM_SIZE_MAX - 1)) / 4;

    if (s_arm7jit_enabled) {
        std::vector<u8> bytes = build_arm7_block(block_ops, cycles);
        int idx = 0;
        for (int k = 0; k < 3 && idx <= 0; ++k)   // retried, like the SH4 installs (rec_wasm.cpp install_block_tries)
            idx = wasm_install_block((uintptr_t)bytes.data(), (int)bytes.size(), pc);
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
            armff_learn(pc, fn, cycles);
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
        flycast_jit_declare_park_arm(pc);   // a route the other consoles did not take: a declared room desync
        // fall through to the v0 runner
    }

    recompiler::EntryPoints[slot] = &arm7_v0_block;
}

void arm7backend_flush()
{
    armff_forget();
    arm_mainloop = &arm_mainloop_c;
    arm_compilecode = &arm_compile_stub;
}

} // namespace aica::arm

#endif // FEAT_AREC != DYNAREC_NONE
