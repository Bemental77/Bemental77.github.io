// test_cvt_single.cpp — emit_convert_to_single (Dolphin ConvertToSingle, the
// value an stfs of a Double-repr FPR stores) under BEM_LEVER_CVT_SINGLE_BRANCH
// (lever_gate.h bit 25), against the reference transcribed here from Dolphin
// Interpreter_FPUtils.h ConvertToSingle:
//   exp = (x >> 52) & 0x7ff
//   exp > 896 or (x & ~sign) == 0  -> ((x >> 32) & 0xc0000000) | ((x >> 29) & 0x3fffffff)
//   exp >= 874                      -> (0x80000000 | (frac >> 21)) >> (905 - exp), | sign
//   otherwise                       -> the first form
// One block (lfd f1,0(r1) ; stfs f1,8(r1)) is compiled once and dispatched for
// every input: every exponent 0..2047 x 24 mantissas x both signs, plus 200,000
// pseudo-random doubles.
//
// Run: node test_cvt_single.js  (exit 0 = PASS)

#include "bementalJIT/bemental.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <emscripten.h>

using namespace bemental;
using namespace bemental::powerpc;

static u32 ref_cvt(u64 x) {
    const u32 exp = (u32)((x >> 52) & 0x7FFu);
    if (exp > 896u || (x & 0x7FFFFFFFFFFFFFFFull) == 0)
        return (u32)(((x >> 32) & 0xC0000000u) | ((x >> 29) & 0x3FFFFFFFu));
    if (exp >= 874u) {
        u32 t = (u32)(0x80000000u | ((x & 0x000FFFFFFFFFFFFFull) >> 21));
        t >>= (905u - exp);
        t |= (u32)((x >> 32) & 0x80000000u);
        return t;
    }
    return (u32)(((x >> 32) & 0xC0000000u) | ((x >> 29) & 0x3FFFFFFFu));
}

static u64 g_rng = 0x9E3779B97F4A7C15ull;
static u64 rnd() { g_rng ^= g_rng << 13; g_rng ^= g_rng >> 7; g_rng ^= g_rng << 17; return g_rng; }

int main() {
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        Module._slow = 0;
        env.ppc_read8 = env.ppc_read16 = env.ppc_read32 = function(a) { Module._slow++; return 0; };
        env.ppc_write8 = env.ppc_write16 = env.ppc_write32 = function(a, v) { Module._slow++; };
        env.ppc_interp = function(i, p) { Module._slow++; };
        env.ppc_check_exc = function(p) { return 0; };
        env.ppc_break_block = function(p, x) {};
        env.ppc_hle_check = function(p) { return 0; };
        env.ppc_hle_fire = function(p, i) { return 0; };
        env.ppc_stack_corrupt = function(a, b, c, d) {};
        env.ppc_msr_updated = function(m) {};
        env.ppc_gather_drain = function() {};
        env.ppc_read_tb = function(w) { return 0; };
    });
    g_hle_hook_query = [](uint32_t) -> bool { return false; };
    u8* raw = (u8*)std::calloc(1, 0x1400);
    const u32 ctx = (u32)(uintptr_t)raw;
    *(u32*)(raw + ppc_off::MSR) = 0x2000u;
    *(u32*)(raw + ppc_off::gpr(1)) = 0x80000000u;
    alignas(16) static u8 buf[64];
    const u32 pc = 0x80720000u;
    const u32 insts[] = {
        (50u << 26) | (1u << 21) | (1u << 16) | 0u,     // lfd  f1,0(r1)
        (52u << 26) | (1u << 21) | (1u << 16) | 8u,     // stfs f1,8(r1)
    };
    std::vector<u8> bytes = build_block_next(pc, insts, 2, ctx, (u32)(uintptr_t)&buf[0],
                                             0x017FFFFFu, sizeof buf);
    BlockCache cache;
    if (bytes.empty() || cache.compile(pc, bytes.data(), bytes.size()) < 0) {
        std::printf("[FAIL] compile\n");
        return 1;
    }
    long n = 0, bad = 0;
    auto one = [&](u64 x) {
        for (int k = 0; k < 8; ++k) buf[k] = (u8)(x >> (56 - 8 * k));
        s32 next = -1;
        cache.dispatch(pc, &next);
        const u32 got = ((u32)buf[8] << 24) | ((u32)buf[9] << 16) | ((u32)buf[10] << 8) | buf[11];
        const u32 want = ref_cvt(x);
        ++n;
        if (got != want) {
            if (bad < 8) std::printf("  [diff] x=%016llx got=%08x want=%08x\n",
                                     (unsigned long long)x, got, want);
            ++bad;
        }
    };
    const u64 mans[] = { 0, 1, 2, 0x1FFFFFull, 0x200000ull, 0x3FFFFFull, 0x1FFFFFFFull, 0x20000000ull,
                         0x7FFFFFFFFull, 0x800000000ull, 0x8000000000000ull, 0x7FFFFFFFFFFFFull,
                         0xFFFFFFFFFFFFFull, 0xFFFFFE0000000ull, 0x123456789ABCDull, 0xAAAAAAAAAAAAAull,
                         0x5555555555555ull, 0x0000100000000ull, 0x8000000000001ull, 0xFFFFFFFF00000ull,
                         0x00000FFFFFFFFull, 0x4000000000000ull, 0x2000000000000ull, 0x0000000080000ull };
    for (u64 sign = 0; sign < 2; ++sign)
        for (u64 e = 0; e < 2048; ++e)
            for (u64 m : mans) one((sign << 63) | (e << 52) | m);
    for (int i = 0; i < 200000; ++i) one(rnd());
    const int slow = EM_ASM_INT({ return Module._slow | 0; });
    const bool ok = bad == 0 && slow == 0;
    std::printf("[%s] ConvertToSingle: %ld inputs, %ld mismatches, %d slow-arm calls\n",
                ok ? "PASS" : "FAIL", n, bad, slow);
    std::printf("[%s] TOTAL %d/1 checks\n", ok ? "PASS" : "FAIL", ok ? 1 : 0);
    std::free(raw);
    return ok ? 0 : 1;
}
