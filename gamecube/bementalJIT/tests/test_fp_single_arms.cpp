// test_fp_single_arms.cpp — differential of the Single-resident FP arms against
// the Double (i64-pair) arms they shortcut, on the LIVE powerpc-next emitter.
//
// Levers covered (lever_gate.h): BEM_LEVER_FP_SINGLE_ARITH (fadds/fsubs/fmuls/
// fdivs on Single inputs), BEM_LEVER_PS_MULS_SIMD (ps_muls0/1), and
// BEM_LEVER_PROMOTE_SIMD (the Single -> i64 widen every block-exit flush runs).
//
//   block S (Single arm):  psq_l f1,0(r3) ; psq_l f2,8(r3) ; OP f0,f1,f2 ; nop
//       psq_l (GQR0 = 0: raw f32 pair) always leaves f1/f2 Single-resident, so
//       OP takes its Single arm and the exit flush promotes f0/f1/f2.
//   block D (Double arm):  OP f0,f1,f2 ; nop      with ps[1]/ps[2] preset to
//       ConvertToDouble of the same f32 bits (what the Double arm would see).
// Checked per vector: f0's two lanes from S == from D (bit-exact; NaN results
// compare as "both NaN" — the wasm spec leaves NaN payloads open in both arms),
// and S's flushed f1/f2 lanes == ConvertToDouble(bits) bit-exactly, NaN payloads
// included (the promote's Inf/NaN path is the scalar exact widen).
// FPSCR.NI is exercised both ways. Run: node test_fp_single_arms.js

#include "bementalJIT/bemental.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <emscripten.h>

using namespace bemental;
using namespace bemental::powerpc;

// Interpreter_FPUtils.h ConvertToDouble, verbatim logic.
static u64 C2D(u32 value) {
    u64 x = value, exp = (x >> 23) & 0xff, frac = x & 0x007fffff;
    if (exp > 0 && exp < 255) {
        u64 y = !(exp >> 7);
        u64 z = y << 61 | y << 60 | y << 59;
        return ((x & 0xc0000000ull) << 32) | z | ((x & 0x3fffffff) << 29);
    } else if (exp == 0 && frac != 0) {
        exp = 1023 - 126;
        do { frac <<= 1; exp -= 1; } while ((frac & 0x00800000) == 0);
        return ((x & 0x80000000ull) << 32) | (exp << 52) | ((frac & 0x007fffff) << 29);
    } else {
        u64 y = exp >> 7;
        u64 z = y << 61 | y << 60 | y << 59;
        return ((x & 0xc0000000ull) << 32) | z | ((x & 0x3fffffff) << 29);
    }
}
static bool isnan64(u64 b) { return ((b >> 52) & 0x7FF) == 0x7FF && (b & 0xFFFFFFFFFFFFFull) != 0; }

EM_JS(void, install_imports, (), {
    if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
    const env = Module.bemental_imports.env;
    Module.__mem = new Map();
    env.ppc_read8 = function(a) { return 0; };
    env.ppc_read16 = function(a) { return 0; };
    env.ppc_read32 = function(a) { const v = Module.__mem.get(a >>> 0); return v === undefined ? 0 : v; };
    env.ppc_write8 = function(a, v) {};
    env.ppc_write16 = function(a, v) {};
    env.ppc_write32 = function(a, v) {};
    env.ppc_interp = function(i, p) {};
    env.ppc_check_exc = function(p) { return 0; };
    env.ppc_break_block = function(p, x) {};
    env.ppc_hle_check = function(p) { return 0; };
    env.ppc_hle_fire = function(p, i) { return 0; };
    env.ppc_stack_corrupt = function(a, b, c, d) {};
    env.ppc_msr_updated = function(m) {};
    env.ppc_gather_drain = function() {};
});
EM_JS(void, set_mem, (u32 addr, u32 val), { Module.__mem.set(addr >>> 0, val | 0); });

static u64 g_rng = 0xD1B54A32D192ED03ull;
static u32 rnd32() { g_rng ^= g_rng << 13; g_rng ^= g_rng >> 7; g_rng ^= g_rng << 17; return (u32)g_rng; }
// Biased f32 bit pattern: zero/denormal/small/normal/huge/Inf/NaN exponents.
static u32 rand_f32_bits() {
    const u32 sign = (rnd32() & 1u) << 31;
    const u32 pick = rnd32() % 16u;
    u32 e;
    if (pick == 0) e = 0;                       // zero / denormal
    else if (pick == 1) e = 255;                // Inf / NaN
    else if (pick == 2) e = 1 + rnd32() % 8u;   // tiny normals (NI flush region)
    else if (pick == 3) e = 247 + rnd32() % 8u; // near overflow
    else e = 100 + rnd32() % 56u;
    u32 m = rnd32() & 0x7FFFFFu;
    if ((rnd32() & 7u) == 0) m = 0;
    return sign | (e << 23) | m;
}

struct Op { const char* name; u32 inst; bool paired; };

int main() {
    install_imports();
    g_hle_hook_query = [](uint32_t) -> bool { return false; };
    auto a_form = [](u32 opcd, u32 xo) -> u32 {   // fD=0 fA=1 fB=2 (or fC=2 for mul)
        const bool mul = (xo == 25 || xo == 12 || xo == 13);
        return (opcd << 26) | (0u << 21) | (1u << 16) | ((mul ? 0u : 2u) << 11) |
               ((mul ? 2u : 0u) << 6) | (xo << 1);
    };
    const Op ops[] = {
        {"fadds",    a_form(59, 21), false},
        {"fsubs",    a_form(59, 20), false},
        {"fmuls",    a_form(59, 25), false},
        {"fdivs",    a_form(59, 18), false},
        {"ps_muls0", a_form(4, 12),  true},
        {"ps_muls1", a_form(4, 13),  true},
    };
    const u32 PSQ_L_F1 = (56u << 26) | (1u << 21) | (3u << 16) | 0u;   // psq_l f1,0(r3),0,0
    const u32 PSQ_L_F2 = (56u << 26) | (2u << 21) | (3u << 16) | 8u;   // psq_l f2,8(r3),0,0
    const u32 NOP = 24u << 26;
    const u32 BASE = 0xCC010000u;   // never fastmem -> the import arm

    constexpr u32 CTX_BYTES = 0x1400;
    u8* ctx = (u8*)std::calloc(1, CTX_BYTES);
    const u32 ctx_ptr = (u32)(uintptr_t)ctx;
    auto ps0 = [&](u32 n) -> u64& { return *(u64*)(ctx + ppc_off::ps0(n)); };
    auto ps1 = [&](u32 n) -> u64& { return *(u64*)(ctx + ppc_off::ps1(n)); };
    auto reset = [&](u32 fpscr) {
        std::memset(ctx, 0, CTX_BYTES);
        *(u32*)(ctx + ppc_off::MSR) = 0x2000u;
        *(u32*)(ctx + ppc_off::FPSCR) = fpscr;
        *(u32*)(ctx + ppc_off::gpr(3)) = BASE;
        ps0(0) = ps1(0) = 0xDEADBEEFCAFEF00Dull;
    };

    long total_fail = 0, total_n = 0;
    u32 pc = 0x80400000u;
    for (const Op& op : ops) {
        BlockCache cs, cd;
        const u32 s_insts[] = {PSQ_L_F1, PSQ_L_F2, op.inst, NOP};
        const u32 d_insts[] = {op.inst, NOP};
        std::vector<u8> sb = build_block_next(pc, s_insts, 4, ctx_ptr, 0, 0, 0);
        std::vector<u8> db = build_block_next(pc + 0x80u, d_insts, 2, ctx_ptr, 0, 0, 0);
        if (cs.compile(pc, sb.data(), sb.size()) < 0 || cd.compile(pc + 0x80u, db.data(), db.size()) < 0) {
            std::printf("[FAIL] %s compile\n", op.name); return 1;
        }
        long fail = 0, n = 0;
        for (int i = 0; i < 40000; ++i) {
            const u32 a0 = rand_f32_bits(), a1 = rand_f32_bits(), b0 = rand_f32_bits(), b1 = rand_f32_bits();
            const u32 fpscr = (rnd32() & 3u) == 0 ? 4u : 0u;   // NI on 1/4 of vectors
            set_mem(BASE + 0, a0); set_mem(BASE + 4, a1); set_mem(BASE + 8, b0); set_mem(BASE + 12, b1);
            s32 next = -1;
            reset(fpscr);
            if (!cs.dispatch(pc, &next)) { ++fail; continue; }
            const u64 s0 = ps0(0), s1 = ps1(0);
            const u64 f1a = ps0(1), f1b = ps1(1), f2a = ps0(2), f2b = ps1(2);
            reset(fpscr);
            ps0(1) = C2D(a0); ps1(1) = C2D(a1); ps0(2) = C2D(b0); ps1(2) = C2D(b1);
            if (!cd.dispatch(pc + 0x80u, &next)) { ++fail; continue; }
            const u64 d0 = ps0(0), d1 = ps1(0);
            auto same = [](u64 x, u64 y) { return (isnan64(x) && isnan64(y)) || x == y; };
            bool ok = same(s0, d0) && same(s1, d1);
            const bool prom_ok = f1a == C2D(a0) && f1b == C2D(a1) && f2a == C2D(b0) && f2b == C2D(b1);
            if (!ok || !prom_ok) {
                if (fail < 6)
                    std::printf("  [mismatch %s] a=%08x/%08x b=%08x/%08x ni=%u single=%016llx/%016llx double=%016llx/%016llx promote_ok=%d\n",
                                op.name, a0, a1, b0, b1, fpscr >> 2, (unsigned long long)s0,
                                (unsigned long long)s1, (unsigned long long)d0, (unsigned long long)d1, (int)prom_ok);
                ++fail;
            }
            ++n;
        }
        std::printf("[%s] %-9s vectors=%ld mismatches=%ld\n", fail ? "FAIL" : "PASS", op.name, n, fail);
        total_fail += fail; total_n += n;
        pc += 0x200u;
    }
    std::printf("[%s] TOTAL: %ld vectors, %ld mismatches\n", total_fail ? "FAIL" : "PASS", total_n, total_fail);
    std::free(ctx);
    return total_fail ? 1 : 0;
}
