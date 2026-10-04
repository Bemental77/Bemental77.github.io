// test_interp_pcsync.cpp — inline interpreter fallbacks must store ctx.PC.
//
// dolphin_interp (dolphin_jit_wimports.cpp) starts with
// `if (ppc_state.pc != pc) return;`, so an inline WIMPORT_INTERP call whose
// op has no pre-op pc store is SILENTLY SKIPPED. The [pc-sync A4 2026-06-28]
// sweep fixed mfspr/mtspr/mftb/FP-Rc/PS-Rc; this checks the three sites it
// missed (integer OE forms, subfme, sraw with a >= 32 shift), with a stub that
// enforces the same guard and executes the op, then checks the guest result
// survives to the block-exit state.
//
//   addi r3, r0, 5 ; addo r4, r3, r3 ; ori      -> r4 = 10
//   addi r3, r0, 5 ; subfme r5, r3 ; ori        -> r5 = ~5 + CA - 1 (CA = 0) = -7
//   addi r3, r0, -8 ; addi r6, r0, 40 ; sraw r7, r3, r6 ; ori  -> r7 = -1
// Run: node test_interp_pcsync.js

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

EM_JS(void, install_imports, (u32 ctx_in, u32 pc_off, u32 g_off, u32 ca_off), {
    if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
    const env = Module.bemental_imports.env;
    const ctx = ctx_in >>> 0;
    const G = (n) => (ctx + g_off + 4 * n) >> 2;
    Module.__skips = 0; Module.__runs = 0;
    env.ppc_read8 = function(a) { return 0; };
    env.ppc_read16 = function(a) { return 0; };
    env.ppc_read32 = function(a) { return 0; };
    env.ppc_write8 = function(a, v) {};
    env.ppc_write16 = function(a, v) {};
    env.ppc_write32 = function(a, v) {};
    env.ppc_interp = function(inst, pc) {
        inst >>>= 0; pc >>>= 0;
        if ((HEAPU32[(ctx + pc_off) >> 2] >>> 0) !== pc) { Module.__skips++; return; }   // the live guard
        Module.__runs++;
        const op = inst >>> 26, xo = (inst >>> 1) & 0x1FF, d = (inst >>> 21) & 31, a = (inst >>> 16) & 31, b = (inst >>> 11) & 31;
        if (op === 31 && xo === 266) HEAP32[G(d)] = (HEAP32[G(a)] + HEAP32[G(b)]) | 0;          // add(o)
        else if (op === 31 && xo === 232) HEAP32[G(d)] = (~HEAP32[G(a)] + HEAPU8[ctx + ca_off] - 1) | 0;   // subfme
        else if (op === 31 && ((inst >>> 1) & 0x3FF) === 792) {                                   // sraw: d=rS, a=rA
            const sh = HEAP32[G(b)] & 63, rs = HEAP32[G(d)];
            HEAP32[G(a)] = sh > 31 ? (rs < 0 ? -1 : 0) : (rs >> sh);
        }
        HEAP32[(ctx + pc_off) >> 2] = (pc + 4) | 0;
    };
    env.ppc_check_exc = function(p) { return 0; };
    env.ppc_break_block = function(p, x) {};
    env.ppc_hle_check = function(p) { return 0; };
    env.ppc_hle_fire = function(p, i) { return 0; };
    env.ppc_stack_corrupt = function(a, b, c, d) {};
    env.ppc_msr_updated = function(m) {};
    env.ppc_gather_drain = function() {};
});
EM_JS(int, skips, (), { return Module.__skips | 0; });
EM_JS(int, runs, (), { return Module.__runs | 0; });

static u32 d_form(u32 opcd, u32 rt, u32 ra, u32 imm) { return (opcd << 26) | (rt << 21) | (ra << 16) | (imm & 0xFFFFu); }
static u32 x_form(u32 rt, u32 ra, u32 rb, u32 xo, u32 oe) { return (31u << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (oe << 10) | (xo << 1); }

int main() {
    constexpr u32 CTX_BYTES = 0x1400;
    u8* ctx = (u8*)std::calloc(1, CTX_BYTES);
    const u32 ctx_ptr = (u32)(uintptr_t)ctx;
    auto gpr = [&](u32 i) -> u32& { return *(u32*)(ctx + ppc_off::gpr(i)); };
    install_imports(ctx_ptr, ppc_off::PC, ppc_off::gpr(0), ppc_off::XER_CA);
    g_hle_hook_query = [](uint32_t) -> bool { return false; };
    struct Case { const char* name; std::vector<u32> insts; u32 reg; u32 want; };
    const Case cases[] = {
        {"addo",   {d_form(14, 3, 0, 5), x_form(4, 3, 3, 266, 1), d_form(24, 0, 0, 0)}, 4, 10u},
        {"subfme", {d_form(14, 3, 0, 5), x_form(5, 3, 0, 232, 0), d_form(24, 0, 0, 0)}, 5, (u32)-7},
        {"sraw>=32", {d_form(14, 3, 0, (u32)-8), d_form(14, 6, 0, 40), (31u << 26) | (3u << 21) | (7u << 16) | (6u << 11) | (792u << 1), d_form(24, 0, 0, 0)}, 7, 0xFFFFFFFFu},
    };
    int fail = 0;
    u32 pc = 0x80500000u;
    for (const Case& c : cases) {
        std::memset(ctx, 0, CTX_BYTES);
        for (u32 i = 0; i < 32; ++i) gpr(i) = 0x11110000u + i;
        *(u32*)(ctx + ppc_off::PC) = pc;   // as the dispatcher leaves it at block entry
        BlockCache cache;
        std::vector<u8> bytes = build_block_next(pc, c.insts.data(), (u32)c.insts.size(), ctx_ptr, 0, 0, 0);
        const int s0 = skips(), r0 = runs();
        bool ok = cache.compile(pc, bytes.data(), bytes.size()) >= 0;
        s32 next = -1;
        ok = ok && cache.dispatch(pc, &next);
        const int sk = skips() - s0, rn = runs() - r0;
        ok = ok && sk == 0 && rn == 1 && gpr(c.reg) == c.want;
        std::printf("[%s] %-8s interp runs=%d skips=%d r%u=%08x (want %08x)\n", ok ? "PASS" : "FAIL",
                    c.name, rn, sk, c.reg, gpr(c.reg), c.want);
        if (!ok) ++fail;
        pc += 0x100u;
    }
    std::printf("[%s] TOTAL\n", fail ? "FAIL" : "PASS");
    std::free(ctx);
    return fail ? 1 : 0;
}
