// test_levers_2632.cpp — the 2026-10-08 op-count levers against independent
// references (lever_gate.h bits 26-30 and word-2 bit 0):
//
//  [hoist]  BEM_LEVER_BASE_HOIST / BEM_LEVER_BASE_HOIST_FP: one block of
//           integer + FP D-form accesses sharing base r3 (displacements
//           -0x8000 .. +0x7FF0, so most groups need both range ends), run for
//           r3 values inside a RAM window, straddling both window ends, in the
//           0x00 / 0x40 / 0xC0 mirrors, wrapping below 0, and in MMIO. The
//           reference applies the per-access rule ((EA & 0x3E000000) == 0 ->
//           MEM1 at EA & 0x01FFFFFF, else the host import) access by access;
//           GPRs, every MEM1 byte the reference wrote (and no other byte near
//           any EA), and the exact sequence of host imports must match.
//  [slowarm] BEM_LEVER_SLOWARM_FP_GP: every host import an FP load/store's slow
//           arm makes sees ctx.PC == that op's address and the dirty GPR the
//           block wrote before it (the deferred flush + PC).
//  [chain]  BEM_LEVER_KNOWN_PC_CHAIN: a program whose blocks end in bc (CR and
//           CTR forms) and b, run through chain_dispatch with in-wasm chaining
//           on and with it off (every exit a host return): same final state at
//           every downcount.
//  [exit]   BEM_LEVER_SINGLE_EDGE_SIMD (exit half): three lfs'd Singles flushed
//           at block exit must land in ps0/ps1 as Dolphin ConvertToDouble of
//           their f32 bits, for every mix of normal / denormal / zero / Inf /
//           quiet and signaling NaN inputs (any NaN forces the per-reg arms).
//           (The entry half needs the shadow-mask cell, i.e. a real lc_base;
//           it is covered by the block_replay trace differential.)
//  [fcmp]   BEM_LEVER2_FCMP_SELECT: fcmpu/fcmpo on Double and Single operands
//           against the packed CR encoding (cr_encode.cpp), for NaN / +-0 /
//           +-Inf / denormal / ordinary pairs.
//
// Run: node test_levers_2632.js  (exit 0 = PASS)

#include "bementalJIT/bemental.h"
#include "bementalJIT/block_cache.h"
#include "guests/powerpc-next/ppc_analyst.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <vector>
#include <emscripten.h>

using namespace bemental;
using namespace bemental::powerpc;

extern "C" { extern unsigned char g_bem_chain_enabled; }

static int g_fails = 0, g_checks = 0;
static void expect(bool c, const char* what) {
    ++g_checks;
    if (!c) { ++g_fails; std::printf("[FAIL] %s\n", what); }
}

static u32 d_form(u32 opcd, u32 rt, u32 ra, s32 d) {
    return (opcd << 26) | (rt << 21) | (ra << 16) | ((u32)d & 0xFFFFu);
}
static u32 psq(u32 opcd, u32 fr, u32 ra, s32 d) {   // W=0, I=0
    return (opcd << 26) | (fr << 21) | (ra << 16) | ((u32)d & 0xFFFu);
}
static constexpr u32 BLR = 0x4E800020u;

// Slow-path guest memory: a byte map with a deterministic default, plus a log
// of every host import (kind, addr, value) and, per call, ctx.PC and gpr[10].
EM_JS(void, install_imports, (u32 ctx), {
    if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
    const env = Module.bemental_imports.env;
    Module.__ctx = ctx >>> 0;
    const pat = (a) => (Math.imul(a >>> 0, 131) + 7) & 0xFF;
    const rb = (a) => { a >>>= 0; const v = Module.__smem.get(a); return v === undefined ? pat(a) : v; };
    const wb = (a, v) => { Module.__smem.set(a >>> 0, v & 0xFF); };
    const log = (k, a, v) => {
        const c = Module.__ctx >>> 2;
        Module.__log.push([k, a >>> 0, v >>> 0, HEAPU32[c + 0] >>> 0 /* PC @0 */,
                           HEAPU32[(Module.__ctx + Module.__gpr10) >>> 2] >>> 0]);
    };
    env.ppc_read8 = function(a) { const v = rb(a); log(0, a, v); return v; };
    env.ppc_read16 = function(a) { const v = (rb(a) << 8) | rb(a + 1); log(1, a, v); return v; };
    env.ppc_read32 = function(a) {
        const v = ((rb(a) << 24) | (rb(a + 1) << 16) | (rb(a + 2) << 8) | rb(a + 3)) >>> 0;
        log(2, a, v); return v | 0; };
    env.ppc_write8 = function(a, v) { log(3, a, v & 0xFF); wb(a, v); };
    env.ppc_write16 = function(a, v) { log(4, a, v & 0xFFFF); wb(a, v >>> 8); wb(a + 1, v); };
    env.ppc_write32 = function(a, v) { log(5, a, v >>> 0);
        wb(a, v >>> 24); wb(a + 1, v >>> 16); wb(a + 2, v >>> 8); wb(a + 3, v); };
    env.ppc_interp = function(i, p) { Module.__interp = (Module.__interp | 0) + 1; };
    env.ppc_check_exc = function(p) { return 0; };
    env.ppc_break_block = function(p, x) {};
    env.ppc_hle_check = function(p) { return 0; };
    env.ppc_hle_fire = function(p, i) { return 0; };
    env.ppc_stack_corrupt = function(a, b, c, d) {};
    env.ppc_msr_updated = function(m) {};
    env.ppc_gather_drain = function() {};
});
EM_JS(void, js_reset, (u32 gpr10_off), {
    Module.__smem = new Map(); Module.__log = []; Module.__interp = 0; Module.__gpr10 = gpr10_off;
});
EM_JS(int, js_log_len, (), { return Module.__log.length; });
EM_JS(u32, js_log_get, (int i, int f), { return Module.__log[i][f] >>> 0; });
EM_JS(int, js_interp, (), { return Module.__interp | 0; });

// ---- shared reference slow memory (same default as the JS one) ----------------
static u8 pat(u32 a) { return (u8)((a * 131u + 7u) & 0xFFu); }
static u8 pat2(u32 i) { return (u8)((i * 2654435761u) >> 24); }   // MEM1 fill

struct Ref {
    std::map<u32, u8> smem, fast;   // slow-path bytes / MEM1 bytes written
    struct Call { u32 k, a, v; };
    std::vector<Call> log;
    const u8* buf;
    u8 rb(u32 a) { auto it = smem.find(a); return it == smem.end() ? pat(a) : it->second; }
    u8 fb(u32 i) { auto it = fast.find(i); return it == fast.end() ? buf[i] : it->second; }
    static bool admit(u32 ea) { return (ea & 0x3E000000u) == 0u; }
    u32 rd(u32 ea, u32 n) {   // big-endian n-byte read, n = 1/2/4
        u32 v = 0;
        if (admit(ea)) { const u32 i = ea & 0x01FFFFFFu; for (u32 k = 0; k < n; ++k) v = (v << 8) | fb(i + k); return v; }
        for (u32 k = 0; k < n; ++k) v = (v << 8) | rb(ea + k);
        log.push_back({n == 1 ? 0u : n == 2 ? 1u : 2u, ea, v});
        return v;
    }
    void wr(u32 ea, u32 n, u32 v) {
        if (admit(ea)) { const u32 i = ea & 0x01FFFFFFu; for (u32 k = 0; k < n; ++k) fast[i + k] = (u8)(v >> (8 * (n - 1 - k))); return; }
        log.push_back({n == 1 ? 3u : n == 2 ? 4u : 5u, ea, n == 4 ? v : v & ((1u << (8 * n)) - 1u)});
        for (u32 k = 0; k < n; ++k) smem[ea + k] = (u8)(v >> (8 * (n - 1 - k)));
    }
    // 8-byte FP access: fast = one 8-byte access if EA is admitted, else two 32-bit imports
    u64 rd8(u32 ea) {
        if (admit(ea)) { const u32 i = ea & 0x01FFFFFFu; u64 v = 0; for (u32 k = 0; k < 8; ++k) v = (v << 8) | fb(i + k); return v; }
        const u64 hi = rd(ea, 4), lo = rd(ea + 4, 4);
        return (hi << 32) | lo;
    }
    void wr8(u32 ea, u64 v) {
        if (admit(ea)) { const u32 i = ea & 0x01FFFFFFu; for (u32 k = 0; k < 8; ++k) fast[i + k] = (u8)(v >> (56 - 8 * k)); return; }
        wr(ea, 4, (u32)(v >> 32)); wr(ea + 4, 4, (u32)v);
    }
};

static u8* g_ctx;
static u32 ctx32(u32 off) { u32 v; std::memcpy(&v, g_ctx + off, 4); return v; }
static void set32(u32 off, u32 v) { std::memcpy(g_ctx + off, &v, 4); }
static u64 ctx64(u32 off) { u64 v; std::memcpy(&v, g_ctx + off, 8); return v; }
static void set64(u32 off, u64 v) { std::memcpy(g_ctx + off, &v, 8); }

static s32 run_block(BlockCache& cache, u32 pc, const u32* insts, u32 n, u32 mem1_base,
                     u32 mask, u32 ram) {
    std::vector<u8> bytes = build_block_next(pc, insts, n, (u32)(uintptr_t)g_ctx, mem1_base,
                                             mask, ram);
    if (bytes.empty() || cache.compile(pc, bytes.data(), bytes.size()) < 0) return -2;
    s32 next = -1;
    cache.dispatch(pc, &next);
    cache.evict(pc);
    return next;
}

// ============================================================================
// [hoist]
// ============================================================================
static void test_hoist(u8* buf, u32 base) {
    // r3 base. f-values pass through untouched: lfs->stfs (Single lane bits),
    // lfd->stfd, psq_l->psq_st (GQR0 FLOAT; data kept normal, so FTZ is a no-op).
    const u32 insts[] = {
        d_form(32, 5, 3, 0),          // lwz  r5,0(r3)
        d_form(32, 6, 3, 8),          // lwz  r6,8(r3)
        d_form(36, 5, 3, -4),         // stw  r5,-4(r3)
        d_form(34, 7, 3, 3),          // lbz  r7,3(r3)
        d_form(44, 6, 3, 10),         // sth  r6,10(r3)
        d_form(42, 8, 3, -2),         // lha  r8,-2(r3)
        d_form(48, 1, 3, 12),         // lfs  f1,12(r3)
        d_form(52, 1, 3, 16),         // stfs f1,16(r3)
        d_form(50, 2, 3, 24),         // lfd  f2,24(r3)
        d_form(54, 2, 3, 32),         // stfd f2,32(r3)
        psq(56, 3, 3, 40),            // psq_l  f3,40(r3)
        psq(60, 3, 3, 48),            // psq_st f3,48(r3)
        d_form(32, 9, 3, 0x7FF0),     // lwz  r9,0x7FF0(r3)
        d_form(38, 9, 3, -0x8000),    // stb  r9,-0x8000(r3)
        d_form(40, 4, 3, 6),          // lhz  r4,6(r3)
        BLR,
    };
    const u32 n = sizeof insts / sizeof insts[0];
    const u32 bases[] = {
        0x80001000u, 0x80008000u, 0x80007FFCu, 0x81FF8000u, 0x81FF800Cu, 0x81FF8020u,
        0x81FFFFF0u, 0x7FFFFFF0u, 0x7FFF8010u, 0xC1FFFFF8u, 0xC0004000u, 0x00000100u,
        0x00007000u, 0x40000010u, 0x3FFFFFF8u, 0x41FFFF00u, 0xCC000000u, 0xCC008000u,
        0xE0000100u, 0x82000000u, 0x01FFFFFCu,
    };
    BlockCache cache;
    for (u32 r3 : bases) {
        // fresh ctx + MEM1 contents around everything this case can touch
        std::memset(g_ctx, 0, 0x1400);
        set32(ppc_off::MSR, 0x2000u);
        set32(ppc_off::gpr(3), r3);
        js_reset(ppc_off::gpr(10));
        const s32 disp[] = { 0, 8, -4, 3, 10, -2, 12, 16, 24, 32, 40, 48, 0x7FF0, -0x8000, 6 };
        for (s32 d : disp) {
            const u32 i = (r3 + (u32)d) & 0x01FFFFFFu;
            for (u32 k = 0; k < 8; ++k) buf[i + k] = pat2(i + k);
        }
        Ref ref; ref.buf = buf;
        // keep normal floats in what the FP loads read (fast or slow)
        auto make_normal_word = [&](u32 ea) {
            if (Ref::admit(ea)) {
                const u32 i = ea & 0x01FFFFFFu;
                buf[i] = 0x3F; buf[i + 1] = 0xC0 | (buf[i + 1] & 0x3F);
            }
        };
        for (s32 d : { 12, 40, 44 }) make_normal_word(r3 + (u32)d);
        // lfd 24: make a normal double
        if (Ref::admit(r3 + 24)) { const u32 i = (r3 + 24) & 0x01FFFFFFu; buf[i] = 0x40; buf[i + 1] = 0x09; }
        const u32 r5 = ref.rd(r3 + 0, 4);
        const u32 r6 = ref.rd(r3 + 8, 4);
        ref.wr(r3 - 4, 4, r5);
        const u32 r7 = ref.rd(r3 + 3, 1);
        ref.wr(r3 + 10, 2, r6);
        const u32 r8 = (u32)(s32)(s16)ref.rd(r3 - 2, 2);
        const u32 f1 = ref.rd(r3 + 12, 4);
        ref.wr(r3 + 16, 4, f1);
        const u64 f2 = ref.rd8(r3 + 24);
        ref.wr8(r3 + 32, f2);
        const u64 f3 = ref.rd8(r3 + 40);
        // psq_st FLOAT stores ConvertToSingleFTZ: an exp==0 word -> its sign
        auto ftz = [](u32 w) { return (w & 0x7F800000u) == 0u ? (w & 0x80000000u) : w; };
        ref.wr8(r3 + 48, ((u64)ftz((u32)(f3 >> 32)) << 32) | ftz((u32)f3));
        const u32 r9 = ref.rd(r3 + 0x7FF0, 4);
        ref.wr(r3 - 0x8000, 1, r9);
        const u32 r4 = ref.rd(r3 + 6, 2);

        const s32 next = run_block(cache, 0x80700000u, insts, n, base, 0x01FFFFFFu, 0x02000000u);
        char what[160];
        std::snprintf(what, sizeof what, "[hoist r3=%08x] block compiled and ran", r3);
        expect(next != -2, what);
        const u32 want[6] = { r4, r5, r6, r7, r8, r9 };
        for (u32 k = 0; k < 6; ++k) {
            std::snprintf(what, sizeof what, "[hoist r3=%08x] r%u = %08x (want %08x)", r3, 4 + k,
                          ctx32(ppc_off::gpr(4 + k)), want[k]);
            expect(ctx32(ppc_off::gpr(4 + k)) == want[k], what);
        }
        bool mem_ok = true;
        for (auto& kv : ref.fast) if (buf[kv.first] != kv.second) mem_ok = false;
        std::snprintf(what, sizeof what, "[hoist r3=%08x] MEM1 bytes the reference wrote", r3);
        expect(mem_ok, what);
        const int L = js_log_len();
        bool log_ok = (size_t)L == ref.log.size();
        for (int k = 0; log_ok && k < L; ++k)
            log_ok = js_log_get(k, 0) == ref.log[k].k && js_log_get(k, 1) == ref.log[k].a &&
                     js_log_get(k, 2) == ref.log[k].v;
        std::snprintf(what, sizeof what, "[hoist r3=%08x] host-import sequence (%d vs %zu calls)",
                      r3, L, ref.log.size());
        expect(log_ok, what);
        // undo every MEM1 write so the next case starts from pat2
        for (auto& kv : ref.fast) buf[kv.first] = pat2(kv.first);
    }
}

// Guard against stray MEM1 writes: a run whose accesses all go to the host must
// leave a sentinel window untouched (and a fully-RAM run must write only where
// the reference does — checked byte-for-byte over a window around r3).
static void test_hoist_stray(u8* buf, u32 base) {
    const u32 insts[] = {
        d_form(36, 5, 3, 0), d_form(36, 6, 3, 4), d_form(38, 7, 3, 9), d_form(44, 8, 3, 14),
        d_form(52, 1, 3, 20), d_form(54, 2, 3, 24), psq(60, 3, 3, 32), BLR,
    };
    BlockCache cache;
    const u32 r3s[] = { 0x80100000u, 0x81FFFFE8u, 0xCC000000u };
    for (u32 r3 : r3s) {
        std::memset(g_ctx, 0, 0x1400);
        set32(ppc_off::MSR, 0x2000u);
        set32(ppc_off::gpr(3), r3);
        for (u32 r = 5; r <= 8; ++r) set32(ppc_off::gpr(r), 0x11223344u * r);
        set64(ppc_off::ps0(1), 0x3FF0000000000000ull);
        set64(ppc_off::ps0(2), 0x4000000000000001ull);
        set64(ppc_off::ps0(3), 0x3FF8000000000000ull); set64(ppc_off::ps1(3), 0xC000000000000000ull);
        js_reset(ppc_off::gpr(10));
        const u32 c = r3 & 0x01FFFFFFu;
        for (u32 i = (c > 64 ? c - 64 : 0); i < c + 128; ++i) buf[i] = pat2(i);
        (void)run_block(cache, 0x80710000u, insts, 8, base, 0x01FFFFFFu, 0x02000000u);
        std::vector<u8> want(192);
        const u32 lo = c > 64 ? c - 64 : 0;
        for (u32 i = lo; i < c + 128; ++i) want[i - lo] = pat2(i);
        if (Ref::admit(r3) && Ref::admit(r3 + 40)) {
            auto put = [&](u32 off, u64 v, u32 nb) {
                for (u32 k = 0; k < nb; ++k) want[c + off - lo + k] = (u8)(v >> (8 * (nb - 1 - k)));
            };
            put(0, 0x11223344u * 5, 4); put(4, 0x11223344u * 6, 4); put(9, (0x11223344u * 7) & 0xFF, 1);
            put(14, (0x11223344u * 8) & 0xFFFF, 2);
            put(20, 0x3F800000u, 4); put(24, 0x4000000000000001ull, 8);
            put(32, 0x3FC00000C0000000ull, 8);
        }
        bool ok = true;
        for (u32 i = lo; i < c + 128; ++i) if (buf[i] != want[i - lo]) ok = false;
        char what[120];
        std::snprintf(what, sizeof what, "[hoist-stray r3=%08x] MEM1 window byte-exact", r3);
        if (Ref::admit(r3) && !Ref::admit(r3 + 40)) continue;   // straddle: covered above
        expect(ok, what);
        for (u32 i = lo; i < c + 128; ++i) buf[i] = pat2(i);
    }
}

// ============================================================================
// [slowarm]  r3 = MMIO -> every FP access takes its host imports.
// ============================================================================
static void test_slowarm() {
    const u32 pc = 0x80720000u;
    const u32 insts[] = {
        d_form(48, 1, 3, 0),          // lfs  f1,0(r3)      (first FP op: keeps its PC store)
        d_form(14, 10, 0, 0x55),      // li   r10,0x55      (dirty GPR)
        d_form(52, 1, 3, 4),          // stfs f1,4(r3)
        d_form(14, 10, 0, 0x66),
        d_form(50, 2, 3, 8),          // lfd  f2,8(r3)
        d_form(14, 10, 0, 0x77),
        d_form(54, 2, 3, 16),         // stfd f2,16(r3)
        d_form(14, 10, 0, 0x88),
        psq(56, 3, 3, 24),            // psq_l  f3,24(r3)
        d_form(14, 10, 0, 0x99),
        psq(60, 3, 3, 32),            // psq_st f3,32(r3)
        d_form(14, 10, 0, 0xAA),
        d_form(48, 4, 3, 40),         // lfs f4,40(r3)
        BLR,
    };
    const u32 n = sizeof insts / sizeof insts[0];
    std::memset(g_ctx, 0, 0x1400);
    set32(ppc_off::MSR, 0x2000u);
    set32(ppc_off::gpr(3), 0xCC000100u);
    js_reset(ppc_off::gpr(10));
    BlockCache cache;
    // mem1_base 0: every access is a host import
    const s32 next = run_block(cache, pc, insts, n, 0, 0, 0);
    expect(next != -2, "[slowarm] block compiled and ran");
    // expected: (op pc, r10 at the call) for each import
    struct E { u32 pc; u32 r10; u32 ncalls; };
    const E ex[] = {
        { pc + 0x00, 0x00, 1 }, { pc + 0x08, 0x55, 1 }, { pc + 0x10, 0x66, 2 },
        { pc + 0x18, 0x77, 2 }, { pc + 0x20, 0x88, 2 }, { pc + 0x28, 0x99, 2 },
        { pc + 0x30, 0xAA, 1 },
    };
    int k = 0;
    bool ok = true;
    for (const E& e : ex)
        for (u32 c = 0; c < e.ncalls; ++c, ++k) {
            if (k >= js_log_len()) { ok = false; break; }
            const u32 gpc = js_log_get(k, 3), g10 = js_log_get(k, 4);
            if (gpc != e.pc || g10 != e.r10) {
                ok = false;
                std::printf("  [slowarm] call %d: ctx.PC=%08x r10=%x, want %08x / %x\n", k, gpc,
                            g10, e.pc, e.r10);
            }
        }
    expect(ok && k == js_log_len(), "[slowarm] every FP host import sees its op's ctx.PC and the flushed GPRs");
}

// ============================================================================
// [chain]
// ============================================================================
static std::map<u32, u32> g_code;
static u32 fetch(u32 pc, void*) { auto it = g_code.find(pc); return it == g_code.end() ? 0u : it->second; }
static u32 b_rel(u32 from, u32 to) { return (18u << 26) | ((to - from) & 0x03FFFFFCu); }
static u32 bc_rel(u32 bo, u32 bi, u32 from, u32 to) {
    return (16u << 26) | (bo << 21) | (bi << 16) | ((to - from) & 0xFFFCu);
}

struct ChainObs { u32 pc, gpr[8], ctr; s32 dc; };
static ChainObs run_chain(bool chain, s32 dc0) {
    g_bem_chain_enabled = chain ? 1u : 0u;
    std::memset(g_ctx, 0, 0x1400);
    set32(ppc_off::MSR, 0x2000u);
    set32(ppc_off::PC, 0x80600000u);
    set32(ppc_off::NPC, 0x80600000u);
    set32(ppc_off::DOWNCOUNT, (u32)dc0);
    set32(ppc_off::ctr_off(), 3u);
    js_reset(ppc_off::gpr(10));
    BlockCache cache;
    for (int guard = 0; guard < 4096; ++guard) {
        const u32 pc = ctx32(ppc_off::PC);
        if (pc == 0x80600400u) break;
        u32 final_pc = pc, trap_pc = 0;
        const s32 nn = cache.chain_dispatch(pc, 4096u, &final_pc, &trap_pc,
            reinterpret_cast<const u32*>(g_ctx + ppc_off::EXCEPTIONS),
            reinterpret_cast<const s32*>(g_ctx + ppc_off::DOWNCOUNT));
        if (trap_pc) { std::printf("[chain] trap %08x\n", trap_pc); break; }
        if (nn > 0) {
            set32(ppc_off::PC, final_pc); set32(ppc_off::NPC, final_pc);
            if ((s32)ctx32(ppc_off::DOWNCOUNT) <= 0) break;
            continue;
        }
        u32 insts[64]; u32 cnt = 0;
        for (u32 p = pc; cnt < 64; p += 4) {
            insts[cnt++] = fetch(p, nullptr);
            if (IsBlockTerminator(insts[cnt - 1]) && !IsForwardConditionalBranch(insts[cnt - 1], p)) break;
        }
        std::vector<u8> bytes = build_block_next(pc, insts, cnt, (u32)(uintptr_t)g_ctx, 0, 0, 0);
        if (bytes.empty() || cache.compile(pc, bytes.data(), bytes.size()) < 0) break;
    }
    ChainObs o{};
    o.pc = ctx32(ppc_off::PC);
    for (u32 i = 0; i < 8; ++i) o.gpr[i] = ctx32(ppc_off::gpr(i));
    o.ctr = ctx32(ppc_off::ctr_off());
    o.dc = (s32)ctx32(ppc_off::DOWNCOUNT);
    return o;
}

static void test_chain() {
    g_code.clear();
    auto put = [](u32 pc, u32 w) { g_code[pc] = w; };
    // A: r3 += 1 ; cmpwi r3,5 ; blt B   (terminal CR-form bc: B taken, C fall-through)
    put(0x80600000u, d_form(14, 3, 3, 1));
    put(0x80600004u, d_form(11, 0, 3, 5));
    put(0x80600008u, bc_rel(12, 0, 0x80600008u, 0x80600100u));
    // C: r5 += 7 ; bdnz C2   (terminal CTR-form bc)
    put(0x8060000Cu, d_form(14, 5, 5, 7));
    put(0x80600010u, bc_rel(16, 0, 0x80600010u, 0x80600200u));
    // fall-through after bdnz: r6 = 0x66 ; b END
    put(0x80600014u, d_form(14, 6, 0, 0x66));
    put(0x80600018u, b_rel(0x80600018u, 0x80600400u));
    // B: r4 += 1 ; b A
    put(0x80600100u, d_form(14, 4, 4, 1));
    put(0x80600104u, b_rel(0x80600104u, 0x80600000u));
    // C2: r7 += 3 ; cmpwi r7,0 ; bne C (CR-form, taken) — loops through C until CTR runs out
    put(0x80600200u, d_form(14, 7, 7, 3));
    put(0x80600204u, d_form(11, 0, 7, 0));
    put(0x80600208u, bc_rel(4, 2, 0x80600208u, 0x8060000Cu));
    put(0x80600400u, b_rel(0x80600400u, 0x80600400u));
    bool ok = true;
    for (s32 dc = -1; dc <= 40; ++dc) {
        const ChainObs a = run_chain(true, dc), b = run_chain(false, dc);
        bool same = a.pc == b.pc && a.ctr == b.ctr && a.dc == b.dc;
        for (u32 i = 0; i < 8; ++i) same = same && a.gpr[i] == b.gpr[i];
        if (!same) {
            ok = false;
            std::printf("  [chain dc=%d] chained pc=%08x r3=%u r4=%u r5=%u r7=%u ctr=%u | host pc=%08x r3=%u r4=%u r5=%u r7=%u ctr=%u\n",
                        dc, a.pc, a.gpr[3], a.gpr[4], a.gpr[5], a.gpr[7], a.ctr, b.pc, b.gpr[3],
                        b.gpr[4], b.gpr[5], b.gpr[7], b.ctr);
        }
    }
    const ChainObs end = run_chain(true, 100000);
    expect(end.pc == 0x80600400u && end.gpr[3] == 5u && end.gpr[4] == 4u && end.gpr[6] == 0x66u &&
           end.gpr[5] == 21u && end.gpr[7] == 6u,
           "[chain] program reaches END with the expected registers");
    expect(ok, "[chain] chained == host-returned at every downcount -1..40");
    g_bem_chain_enabled = 1u;
}

// ============================================================================
// [exit]
// ============================================================================
static u64 convert_to_double(u32 v) {   // Dolphin ConvertToDouble (Interpreter_FPUtils.h)
    if ((v & 0x7F800000u) == 0x7F800000u)
        return ((u64)(v & 0xC0000000u) << 32) | 0x3800000000000000ull |
               ((u64)(v & 0x3FFFFFFFu) << 29);
    float f; std::memcpy(&f, &v, 4);
    const double d = (double)f;
    u64 r; std::memcpy(&r, &d, 8);
    return r;
}

static void test_exit(u8* buf, u32 base) {
    const u32 vals[] = { 0x3F800000u, 0xC0490FDBu, 0x00000001u, 0x807FFFFFu, 0x00000000u,
                         0x80000000u, 0x7F800000u, 0xFF800000u, 0x7FC00001u, 0x7F800123u,
                         0xFFA00000u, 0x00800000u };
    const u32 nv = sizeof vals / sizeof vals[0];
    const u32 insts[] = { d_form(48, 1, 3, 0), d_form(48, 2, 3, 4), d_form(48, 3, 3, 8), BLR };
    BlockCache cache;
    bool ok = true;
    int cases = 0;
    for (u32 a = 0; a < nv; ++a)
        for (u32 b = 0; b < nv; ++b)
            for (u32 c = 0; c < nv; c += 3) {
                std::memset(g_ctx, 0, 0x1400);
                set32(ppc_off::MSR, 0x2000u);
                set32(ppc_off::gpr(3), 0x80300000u);
                const u32 v3[3] = { vals[a], vals[b], vals[c] };
                for (u32 k = 0; k < 3; ++k)
                    for (u32 j = 0; j < 4; ++j) buf[0x00300000u + 4 * k + j] = (u8)(v3[k] >> (24 - 8 * j));
                js_reset(ppc_off::gpr(10));
                (void)run_block(cache, 0x80730000u, insts, 4, base, 0x01FFFFFFu, 0x02000000u);
                ++cases;
                for (u32 k = 0; k < 3; ++k) {
                    const u64 want = convert_to_double(v3[k]);
                    const u64 p0 = ctx64(ppc_off::ps0(1 + k)), p1 = ctx64(ppc_off::ps1(1 + k));
                    if (p0 != want || p1 != want) {
                        if (ok) std::printf("  [exit] f%u from %08x: ps0=%016llx ps1=%016llx want %016llx\n",
                                            1 + k, v3[k], (unsigned long long)p0, (unsigned long long)p1,
                                            (unsigned long long)want);
                        ok = false;
                    }
                }
            }
    char what[120];
    std::snprintf(what, sizeof what, "[exit] %d three-Single exit flushes == ConvertToDouble per lane", cases);
    expect(ok, what);
}

// ============================================================================
// [fcmp]
// ============================================================================
static u64 cr_ref(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return 0x8800000100000001ull;
    if (a < b) return 0xC000000100000001ull;
    if (a > b) return 0x0000000100000001ull;
    return 0x8000000100000000ull;
}

static void test_fcmp(u8* buf, u32 base) {
    const u64 dv[] = { 0x3FF0000000000000ull, 0xBFF0000000000000ull, 0x0000000000000000ull,
                       0x8000000000000000ull, 0x7FF0000000000000ull, 0xFFF0000000000000ull,
                       0x7FF8000000000000ull, 0x7FF0000000000001ull, 0x0000000000000001ull,
                       0x4000000000000001ull, 0x3FF0000020000000ull, 0xC08F400000000000ull };
    const u32 nd = sizeof dv / sizeof dv[0];
    const u32 sv[] = { 0x3F800000u, 0xBF800000u, 0x00000000u, 0x80000000u, 0x7F800000u,
                       0x7FC00000u, 0x00000001u, 0x447A0000u };
    const u32 ns = sizeof sv / sizeof sv[0];
    // lfd f1,0(r3); lfd f2,8(r3); fcmpu cr1,f1,f2; fcmpo cr2,f2,f1;
    // psq_l f3,16(r3) (Single [ps0=sv, ps1=s2]); fcmpu cr3,f3,f1; fcmpo cr4,f1,f3;
    // lfs f4,20(r3); fcmpu cr5,f3,f4
    auto fcmp = [](u32 xo, u32 crf, u32 fa, u32 fb) {
        return (63u << 26) | (crf << 23) | (fa << 16) | (fb << 11) | (xo << 1);
    };
    const u32 insts[] = {
        d_form(50, 1, 3, 0), d_form(50, 2, 3, 8), fcmp(0, 1, 1, 2), fcmp(32, 2, 2, 1),
        psq(56, 3, 3, 16), fcmp(0, 3, 3, 1), fcmp(32, 4, 1, 3), d_form(48, 4, 3, 20),
        fcmp(0, 5, 3, 4), BLR,
    };
    BlockCache cache;
    bool ok = true;
    int cases = 0;
    for (u32 i = 0; i < nd; ++i)
        for (u32 j = 0; j < nd; ++j)
            for (u32 s = 0; s < ns; ++s) {
                const u32 s2 = sv[(s * 5 + i + j) % ns];
                std::memset(g_ctx, 0, 0x1400);
                set32(ppc_off::MSR, 0x2000u);
                set32(ppc_off::gpr(3), 0x80310000u);
                u8* m = buf + 0x00310000u;
                for (u32 k = 0; k < 8; ++k) { m[k] = (u8)(dv[i] >> (56 - 8 * k)); m[8 + k] = (u8)(dv[j] >> (56 - 8 * k)); }
                for (u32 k = 0; k < 4; ++k) { m[16 + k] = (u8)(sv[s] >> (24 - 8 * k)); m[20 + k] = (u8)(s2 >> (24 - 8 * k)); }
                js_reset(ppc_off::gpr(10));
                (void)run_block(cache, 0x80740000u, insts, 10, base, 0x01FFFFFFu, 0x02000000u);
                ++cases;
                double a, b; std::memcpy(&a, &dv[i], 8); std::memcpy(&b, &dv[j], 8);
                float f3, f4; std::memcpy(&f3, &sv[s], 4); std::memcpy(&f4, &s2, 4);
                const u64 want[5] = { cr_ref(a, b), cr_ref(b, a), cr_ref(f3, a), cr_ref(a, f3),
                                      cr_ref(f3, f4) };
                for (u32 k = 0; k < 5; ++k) {
                    const u64 got = ctx64(ppc_off::cr(1 + k));
                    if (got != want[k]) {
                        if (ok) std::printf("  [fcmp] cr%u got %016llx want %016llx (d %016llx %016llx s %08x %08x)\n",
                                            1 + k, (unsigned long long)got, (unsigned long long)want[k],
                                            (unsigned long long)dv[i], (unsigned long long)dv[j], sv[s], s2);
                        ok = false;
                    }
                }
            }
    char what[120];
    std::snprintf(what, sizeof what, "[fcmp] %d cases x 5 compares == packed CR reference", cases);
    expect(ok, what);
}

int main() {
    g_ctx = (u8*)std::calloc(1, 0x1400 + 0x100);
    install_imports((u32)(uintptr_t)g_ctx);
    g_hle_hook_query = [](uint32_t) -> bool { return false; };
    g_bem_chain_enabled = 1u;
    // MEM1: 32 MB + slack for the accesses that straddle the top (as live).
    u8* buf = (u8*)std::malloc(0x02010000u);
    if (!buf) { std::printf("[FAIL] alloc\n"); return 1; }
    for (u32 i = 0; i < 0x02010000u; ++i) buf[i] = pat2(i);
    const u32 base = (u32)(uintptr_t)buf;

    test_hoist(buf, base);
    test_hoist_stray(buf, base);
    test_slowarm();
    test_chain();
    test_exit(buf, base);
    test_fcmp(buf, base);

    const bool ok = g_fails == 0;
    std::printf("[%s] TOTAL %d/%d checks\n", ok ? "PASS" : "FAIL", g_checks - g_fails, g_checks);
    return ok ? 0 : 1;
}
