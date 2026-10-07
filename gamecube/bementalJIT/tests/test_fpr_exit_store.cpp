// test_fpr_exit_store.cpp — BEM_LEVER_FPR_EXIT_STORE (lever_gate.h bit 23): at a
// flush that leaves the block, a dirty Single FPR with no Inf/NaN lane is stored
// to ps0/ps1 by ONE v128.store of f64x2.promote_low_f32x4; an Inf/NaN lane
// takes the scalar NaN-exact widen and two i64 stores.
//
// psq_l (W=0, GQR0 = 0: two big-endian f32 from fastmem) leaves the FPR Single
// and dirty, so the block exit is what writes ps[]. Three exits: a terminal `b`
// (the pre-terminal exiting flush), a cap-cut ALU terminator (the epilogue's
// exiting flush) and a terminal `blr`. Expected ps0/ps1 bits come from a
// reference ConvertToDouble written here (Dolphin FloatUtils semantics: exp 255
// -> f64 exp 0x7FF with the mantissa << 29 and the sign kept; anything else is
// the exact value), never from the emitter.
//
// Also BEM_LEVER_FPR_EXIT_FLUSH (bit 24): a mid-block beq's taken arm is the
// only FPR flush on that path; both outcomes are checked.
//
// Run: node test_fpr_exit_store.js  (exit 0 = PASS)

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

static u64 ref_widen(u32 f) {
    const u64 sign = (u64)(f >> 31) << 63;
    const u32 exp = (f >> 23) & 0xFFu, man = f & 0x7FFFFFu;
    if (exp == 0xFFu) return sign | (0x7FFull << 52) | ((u64)man << 29);
    float x; std::memcpy(&x, &f, 4);
    const double d = (double)x;
    u64 r; std::memcpy(&r, &d, 8);
    return r;
}

static u32 enc_psq_l(u32 d_, u32 a, s32 disp) {   // W=0, I=0
    return (56u << 26) | ((d_ & 31u) << 21) | ((a & 31u) << 16) | ((u32)disp & 0xFFFu);
}

static int g_checks = 0, g_fails = 0;

// Load fd from {w0, w1} (big-endian in guest memory) and leave the block via
// `term` (a terminal instruction word, or 0 for a cap-cut `addi r9,r9,1`).
static void run(const char* name, u32 term, u32 w0, u32 w1) {
    u8* raw = (u8*)std::calloc(1, 0x1400);
    const u32 ctx = (u32)(uintptr_t)raw;
    *(u32*)(raw + ppc_off::MSR) = 0x2000u;
    *(u32*)(raw + ppc_off::spr(920)) = 0xA0000000u;             // HID2.PSE|LSQE
    *(u32*)(raw + ppc_off::lr_off()) = 0x80700100u;
    alignas(16) static u8 buf[64];
    std::memset(buf, 0, sizeof buf);
    for (int k = 0; k < 4; ++k) { buf[k] = (u8)(w0 >> (24 - 8 * k)); buf[4 + k] = (u8)(w1 >> (24 - 8 * k)); }
    *(u32*)(raw + ppc_off::gpr(1)) = 0x80000000u;
    for (u32 i = 0; i < 32; ++i) {
        *(u64*)(raw + ppc_off::ps0(i)) = 0x1111111111111111ull * (i + 1);
        *(u64*)(raw + ppc_off::ps1(i)) = 0x2222222222222222ull * (i + 1);
    }
    const u32 pc = 0x80700000u;
    std::vector<u32> insts = { enc_psq_l(3, 1, 0), enc_psq_l(4, 1, 0) };
    insts.push_back(term ? term : ((14u << 26) | (9u << 21) | (9u << 16) | 1u));
    std::vector<u8> bytes = build_block_next(pc, insts.data(), (u32)insts.size(), ctx,
                                             (u32)(uintptr_t)&buf[0], 0x017FFFFFu, sizeof buf);
    BlockCache cache;
    s32 next = -1;
    bool ok = !bytes.empty() && cache.compile(pc, bytes.data(), bytes.size()) >= 0 &&
              cache.dispatch(pc, &next);
    const u64 e0 = ref_widen(w0), e1 = ref_widen(w1);
    for (u32 f = 3; f <= 4; ++f)
        ok = ok && *(u64*)(raw + ppc_off::ps0(f)) == e0 && *(u64*)(raw + ppc_off::ps1(f)) == e1;
    for (u32 i = 0; i < 32; ++i) {
        if (i == 3 || i == 4) continue;
        if (*(u64*)(raw + ppc_off::ps0(i)) != 0x1111111111111111ull * (i + 1) ||
            *(u64*)(raw + ppc_off::ps1(i)) != 0x2222222222222222ull * (i + 1)) ok = false;
    }
    ++g_checks;
    if (!ok) ++g_fails;
    std::printf("[%s] %s: f3 = %016llx:%016llx (want %016llx:%016llx) next=%08x\n", ok ? "PASS" : "FAIL",
                name, (unsigned long long)*(u64*)(raw + ppc_off::ps0(3)),
                (unsigned long long)*(u64*)(raw + ppc_off::ps1(3)), (unsigned long long)e0,
                (unsigned long long)e1, (u32)next);
    std::free(raw);
}

int main() {
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        env.ppc_read8 = env.ppc_read16 = env.ppc_read32 = function(a) { return 0; };
        env.ppc_write8 = env.ppc_write16 = env.ppc_write32 = function(a, v) {};
        env.ppc_interp = function(i, p) {};
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
    const u32 B_TERM = (18u << 26) | 0x100u;          // b +0x100
    const u32 BLR = 0x4E800020u;
    struct V { const char* name; u32 w0, w1; };
    const V vals[] = {
        {"normal", 0x3FC00000u, 0xC0100000u},              // 1.5f, -2.25f
        {"denormal", 0x00000123u, 0x80400000u},            // tiny denormal, -min-ish
        {"zeros", 0x00000000u, 0x80000000u},
        {"inf+nan", 0x7F800000u, 0x7FC12345u},             // slow arm
        {"snan lane1", 0x3F800000u, 0xFF812345u},          // slow arm via lane 1
    };
    for (const V& v : vals) {
        char n[96];
        std::snprintf(n, sizeof n, "b-exit %s", v.name);   run(n, B_TERM, v.w0, v.w1);
        std::snprintf(n, sizeof n, "epilogue %s", v.name); run(n, 0u, v.w0, v.w1);
        std::snprintf(n, sizeof n, "blr-exit %s", v.name); run(n, BLR, v.w0, v.w1);
    }
    // [BEM_LEVER_FPR_EXIT_FLUSH, bit 24] a MID-BLOCK beq flushes FPRs only in
    // its taken arm:  psq_l f3 ; cmpwi r5,0 ; beq +0x40 ; ps_add f3,f3,f3 ; b
    // r5 = 0 leaves at the beq with f3 = the loaded pair (stored by the arm);
    // r5 = 1 falls through with f3 still Single/dirty and doubles it.
    for (u32 r5 = 0; r5 < 2; ++r5) {
        u8* raw = (u8*)std::calloc(1, 0x1400);
        const u32 ctx = (u32)(uintptr_t)raw;
        *(u32*)(raw + ppc_off::MSR) = 0x2000u;
        *(u32*)(raw + ppc_off::spr(920)) = 0xA0000000u;
        *(u32*)(raw + ppc_off::gpr(1)) = 0x80000000u;
        *(u32*)(raw + ppc_off::gpr(5)) = r5;
        alignas(16) static u8 buf2[64];
        std::memset(buf2, 0, sizeof buf2);
        const u8 src[8] = {0x3F, 0xC0, 0, 0, 0xC0, 0x10, 0, 0};       // 1.5f, -2.25f
        std::memcpy(buf2, src, 8);
        const u32 pc = 0x80710000u;
        const u32 insts[] = {
            enc_psq_l(3, 1, 0),
            (11u << 26) | (5u << 16),                                  // cmpwi r5,0
            (16u << 26) | (12u << 21) | (2u << 16) | 0x40u,            // beq +0x40
            (4u << 26) | (3u << 21) | (3u << 16) | (3u << 11) | (21u << 1),   // ps_add f3,f3,f3
            (18u << 26) | 0x100u,                                      // b +0x100
        };
        std::vector<u8> bytes = build_block_next(pc, insts, 5, ctx, (u32)(uintptr_t)&buf2[0],
                                                 0x017FFFFFu, sizeof buf2);
        BlockCache cache;
        s32 next = -1;
        bool ok = !bytes.empty() && cache.compile(pc, bytes.data(), bytes.size()) >= 0 &&
                  cache.dispatch(pc, &next);
        const u64 e0 = r5 ? ref_widen(0x40400000u) : ref_widen(0x3FC00000u);   // 3.0f : 1.5f
        const u64 e1 = r5 ? ref_widen(0xC0900000u) : ref_widen(0xC0100000u);   // -4.5f : -2.25f
        const u32 want_pc = r5 ? 0x80710110u : 0x80710048u;
        ok = ok && *(u64*)(raw + ppc_off::ps0(3)) == e0 && *(u64*)(raw + ppc_off::ps1(3)) == e1 &&
             (u32)next == want_pc;
        ++g_checks;
        if (!ok) ++g_fails;
        std::printf("[%s] mid-block beq %s: f3 = %016llx:%016llx (want %016llx:%016llx) next=%08x\n",
                    ok ? "PASS" : "FAIL", r5 ? "falls through" : "taken",
                    (unsigned long long)*(u64*)(raw + ppc_off::ps0(3)),
                    (unsigned long long)*(u64*)(raw + ppc_off::ps1(3)), (unsigned long long)e0,
                    (unsigned long long)e1, (u32)next);
        std::free(raw);
    }
    std::printf("[%s] TOTAL %d/%d checks\n", g_fails ? "FAIL" : "PASS", g_checks - g_fails, g_checks);
    return g_fails ? 1 : 0;
}
