// test_fma_exact.cpp — randomized + constructed-tie differential for the
// single-precision fused multiply-add family on the LIVE powerpc-next emitter.
//
// WHY: emit_single_fma_lane's PM24 fast arm claimed "f64.mul + f64.add + demote
// == NI_madd_msub<single> + ForceSingle by construction" for f32-valued inputs,
// verified on 7.9e8 RANDOM vectors. It is false: Dolphin's own motivating input
// (Interpreter_FPUtils.h:356-370 — a=0x42480000 c=0xbc88cc38 b=0x1b1c72a0, all
// f32-valued) double-rounds to 0xbf55bf18 against the correct 0xbf55bf17. The
// failing inputs need the f64 sum to land EXACTLY on an f32 rounding tie, which
// random vectors hit ~2^-24 of the time. This test CONSTRUCTS such ties, so it
// fails on the PM24 arm and must pass on the tie-corrected arm that replaced it.
//
// Reference: a direct transcription of NI_madd_msub<sub, single=true>
// (Interpreter_FPUtils.h:285-490, non-NaN path) + ForceSingle (NI=0:
// double(float(x))) + the fnm* negate (Interpreter_FloatingPoint.cpp
// fnmaddsx/fnmsubsx: Fill(isnan(r) ? r : -r)), using std::fma.
// NaN results are compared as "both NaN" only (the native default
// m_accurate_nans=false leaves the raw IEEE NaN; the ladder is compiled out).
//
// Each opcode's block is compiled ONCE and re-dispatched per vector.
//
// Exit 0 iff every vector matches. Prints the number of vectors on which the
// naive double-rounded result differs from the reference ("discriminating") —
// it must be > 0 for the test to mean anything.

#include "bementalJIT/bemental.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

using namespace bemental;
using namespace bemental::powerpc;

static u64 dbits(double d) { u64 r; std::memcpy(&r, &d, 8); return r; }
static double bitsd(u64 b) { double r; std::memcpy(&r, &b, 8); return r; }
static float bitsf(u32 b) { float r; std::memcpy(&r, &b, 4); return r; }

// Interpreter_FPUtils.h:91-124 Force25Bit (normal-path form; test operands are
// never double subnormals).
static double force25(double d) {
    u64 i = dbits(d);
    i = (i & 0xFFFFFFFFF8000000ull) + (i & 0x8000000ull);
    return bitsd(i);
}

// NI_madd_msub<sub, true> value path (no FPSCR side effects modelled).
static double ref_madd_msub_single(double a, double c, double b, bool sub) {
    const double c_round = force25(c);
    const double b_sign = sub ? -b : b;
    double r = std::fma(a, c_round, b_sign);
    const u64 rb = dbits(r);
    if ((rb & 0x000000001fffffffull) == 0x0000000010000000ull) {
        const double a_prime = b_sign - r;
        const double b_prime = r + a_prime;
        const double delta_a = std::fma(a, c_round, a_prime);
        const double delta_b = b_sign - b_prime;
        const double error = delta_a + delta_b;
        if (error != 0.0) {
            if ((error > 0.0) == (r > 0.0)) r = bitsd(rb + 1);
            else                            r = bitsd(rb - 1);
        }
    }
    return r;
}

// Full op reference (NI = 0): ForceSingle then optional NaN-safe negate.
static double ref_op(double a, double c, double b, bool sub, bool neg) {
    double r = ref_madd_msub_single(a, c, b, sub);
    r = (double)(float)r;
    if (neg && !std::isnan(r)) r = -r;
    return r;
}

// The PM24 arm's arithmetic (what the old emitter produced for f32-valued a,c,b).
static double naive_op(double a, double c, double b, bool sub, bool neg) {
    double r = sub ? a * c - b : a * c + b;
    r = (double)(float)r;
    if (neg && !std::isnan(r)) r = -r;
    return r;
}

static u64 g_rng = 0x9E3779B97F4A7C15ull;
static u64 rnd() { g_rng ^= g_rng << 13; g_rng ^= g_rng >> 7; g_rng ^= g_rng << 17; return g_rng; }

static double rand_f32_valued(int exp_lo, int exp_hi) {
    const u32 sign = (u32)(rnd() & 1) << 31;
    const u32 e = (u32)(exp_lo + (int)(rnd() % (u64)(exp_hi - exp_lo + 1))) & 0xFF;
    const u32 m = (u32)(rnd() & 0x7FFFFF);
    return (double)bitsf(sign | (e << 23) | m);
}

struct Op { const char* name; u32 inst; bool paired; int c_lane; bool sub; bool neg; };

int main() {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        env.ppc_read8 = function(a) { return 0; };
        env.ppc_read16 = function(a) { return 0; };
        env.ppc_read32 = function(a) { return 0; };
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
#endif
    // f0 = dest, f1 = A, f2 = C, f3 = B.  op59 A-form: OPCD|D|A|B|C|XO|Rc.
    auto a_form = [](u32 opcd, u32 xo) -> u32 {
        return (opcd << 26) | (0u << 21) | (1u << 16) | (3u << 11) | (2u << 6) | (xo << 1);
    };
    const Op ops[] = {
        {"fmadds",    a_form(59, 29), false, 0, false, false},
        {"fmsubs",    a_form(59, 28), false, 0, true,  false},
        {"fnmadds",   a_form(59, 31), false, 0, false, true},
        {"fnmsubs",   a_form(59, 30), false, 0, true,  true},
        {"ps_madd",   a_form(4, 29),  true, -1, false, false},
        {"ps_nmsub",  a_form(4, 30),  true, -1, true,  true},
        {"ps_madds0", a_form(4, 14),  true,  0, false, false},
        {"ps_madds1", a_form(4, 15),  true,  1, false, false},
    };

    constexpr u32 CTX_BYTES = 0x1400;
    u8* ctx = (u8*)std::calloc(1, CTX_BYTES);
    const u32 ctx_ptr = (u32)(uintptr_t)ctx;
    auto ps0 = [&](u32 n) -> u64& { return *(u64*)(ctx + ppc_off::ps0(n)); };
    auto ps1 = [&](u32 n) -> u64& { return *(u64*)(ctx + ppc_off::ps1(n)); };

    long total_fail = 0, total_vec = 0, total_disc = 0;
    u32 pc = 0x80300000u;
    for (const Op& op : ops) {
        BlockCache cache;
        std::vector<u8> bytes = build_block_next(pc, &op.inst, 1, ctx_ptr, 0, 0, 0);
        if (cache.compile(pc, bytes.data(), bytes.size()) < 0) {
            std::printf("[FAIL] %s compile\n", op.name); return 1;
        }
        long fail = 0, n = 0, disc = 0;
        auto run_one = [&](double a0, double c0, double b0, double a1, double c1, double b1) {
            std::memset(ctx, 0, CTX_BYTES);
            *(u32*)(ctx + ppc_off::MSR) = 0x2000u;   // MSR.FP
            *(u32*)(ctx + ppc_off::FPSCR) = 0u;      // NI = 0
            ps0(0) = 0xDEADBEEFCAFEF00Dull; ps1(0) = 0xDEADBEEFCAFEF00Dull;
            ps0(1) = dbits(a0); ps1(1) = dbits(a1);
            ps0(2) = dbits(c0); ps1(2) = dbits(c1);
            ps0(3) = dbits(b0); ps1(3) = dbits(b1);
            s32 next = -1;
            if (!cache.dispatch(pc, &next)) { ++fail; return; }
            double e0, e1, n0, n1;
            if (!op.paired) {
                e0 = e1 = ref_op(a0, c0, b0, op.sub, op.neg);
                n0 = n1 = naive_op(a0, c0, b0, op.sub, op.neg);
            } else {
                const double cc0 = op.c_lane < 0 ? c0 : (op.c_lane == 0 ? c0 : c1);
                const double cc1 = op.c_lane < 0 ? c1 : (op.c_lane == 0 ? c0 : c1);
                e0 = ref_op(a0, cc0, b0, op.sub, op.neg);
                e1 = ref_op(a1, cc1, b1, op.sub, op.neg);
                n0 = naive_op(a0, cc0, b0, op.sub, op.neg);
                n1 = naive_op(a1, cc1, b1, op.sub, op.neg);
            }
            const u64 g0 = ps0(0), g1 = ps1(0);
            auto same = [](u64 got, double exp) {
                if (std::isnan(exp)) return std::isnan(bitsd(got));
                return got == dbits(exp);
            };
            if (dbits(n0) != dbits(e0) || dbits(n1) != dbits(e1)) ++disc;
            if (!same(g0, e0) || !same(g1, e1)) {
                if (fail < 6)
                    std::printf("  [mismatch %s] a=%016llx c=%016llx b=%016llx got=%016llx/%016llx exp=%016llx/%016llx\n",
                                op.name, (unsigned long long)dbits(a0), (unsigned long long)dbits(c0),
                                (unsigned long long)dbits(b0), (unsigned long long)g0,
                                (unsigned long long)g1, (unsigned long long)dbits(e0),
                                (unsigned long long)dbits(e1));
                ++fail;
            }
            ++n;
        };
        // 1. Dolphin's documented case, both signs of b and with sign flips.
        {
            const double a = (double)bitsf(0x42480000u), c = (double)bitsf(0xbc88cc38u);
            const double b = (double)bitsf(0x1b1c72a0u);
            for (int s = 0; s < 8; ++s) {
                const double sa = (s & 1) ? -a : a, sc = (s & 2) ? -c : c, sb = (s & 4) ? -b : b;
                run_one(sa, sc, sb, sa, sc, sb);
            }
        }
        // 2. Constructed ties: a has an odd 24-bit significand in [2^23, 2^25/3),
        //    c = +-1.5 * 2^k, so a*c lands exactly halfway between two f32s; b is
        //    a small f32 or a genuine double, of either sign, below / near the
        //    f64 ulp of the product (double rounding discards or carries it).
        for (int i = 0; i < 60000; ++i) {
            auto tie_pair = [&](double& a, double& c, double& b) {
                const u32 ma = 0x800001u + 2u * (u32)(rnd() % ((0xAAAAAAu - 0x800001u) / 2u));
                const int ea = (int)(rnd() % 40) - 20, ec = (int)(rnd() % 40) - 20;
                a = std::ldexp((double)ma, ea - 23);
                c = std::ldexp(1.5, ec);
                if (rnd() & 1) a = -a;
                if (rnd() & 1) c = -c;
                const int pe = std::ilogb(a * c);
                const int be = pe - 30 - (int)(rnd() % 40);
                if (rnd() & 1) b = (double)(float)std::ldexp(1.0 + (double)(rnd() & 0xFFFFF) / 1048576.0, be);
                else           b = std::ldexp(1.0 + (double)(rnd() & 0xFFFFFFFFFFFFull) / 281474976710656.0, be);
                if (rnd() & 1) b = -b;
            };
            double a0, c0, b0, a1, c1, b1;
            tie_pair(a0, c0, b0); tie_pair(a1, c1, b1);
            run_one(a0, c0, b0, a1, c1, b1);
        }
        // 3. Random f32-valued a, c; b f32-valued or double; plus a slow-arm share
        //    where a is a genuine double (the fast arm's guard must reject it).
        for (int i = 0; i < 60000; ++i) {
            auto rnd_trip = [&](double& a, double& c, double& b) {
                a = rand_f32_valued(100, 154);
                c = rand_f32_valued(100, 154);
                b = (rnd() & 1) ? rand_f32_valued(80, 170)
                                : std::ldexp(1.0 + (double)(rnd() & 0xFFFFFFFFFFFFFull) / 4503599627370496.0,
                                             (int)(rnd() % 120) - 60) * ((rnd() & 1) ? -1.0 : 1.0);
                if ((rnd() & 7) == 0) a = a * (1.0 + 1.0 / 1048577.0);   // not f32-valued
            };
            double a0, c0, b0, a1, c1, b1;
            rnd_trip(a0, c0, b0); rnd_trip(a1, c1, b1);
            run_one(a0, c0, b0, a1, c1, b1);
        }
        // 4. Specials: zeros, infinities (no NaN inputs; NaN results compare loosely).
        {
            const double sp[] = {0.0, -0.0, INFINITY, -INFINITY, 1.0, -2.5, 3.0e38, 1.0e-40};
            for (double a : sp) for (double c : sp) for (double b : sp) run_one(a, c, b, b, a, c);
        }
        std::printf("[%s] %-9s vectors=%ld mismatches=%ld discriminating(naive!=ref)=%ld\n",
                    fail ? "FAIL" : "PASS", op.name, n, fail, disc);
        total_fail += fail; total_vec += n; total_disc += disc;
        pc += 0x100u;
    }
    std::printf("[%s] TOTAL: %ld vectors, %ld mismatches, %ld discriminating\n",
                (total_fail == 0 && total_disc > 0) ? "PASS" : "FAIL", total_vec, total_fail, total_disc);
    std::free(ctx);
    return (total_fail == 0 && total_disc > 0) ? 0 : 1;
}
