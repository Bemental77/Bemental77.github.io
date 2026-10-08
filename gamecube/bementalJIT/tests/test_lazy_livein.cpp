// test_lazy_livein.cpp — BEM_LEVER_LAZY_LIVEIN (lever_gate.h bit 22): GPR
// live-ins are loaded at the top of the first op that reads them, not all at
// block entry.
//
// (1) Functional, through build_block_next + BlockCache: a block that can leave
//     at a mid-block forward beq BEFORE its other live-ins are first read
//
//       80600000  cmpwi  r3, 0
//       80600004  beq    80600040           (mid-block exit)
//       80600008  add    r5, r4, r6         (r4, r6: first read here)
//       8060000C  rlwimi r7, r8, 8, 0, 23   (r7 read-modify-write, r8 read)
//       80600010  addi   r9, r9, 1          (r9 read-modify-write)
//       80600014  or     r10, r11, r11      (r10 written, r11 read)
//       80600018  b      80600080           (terminal)
//
//     run with r3 = 0 (exit taken: PC 80600040, every GPR unchanged) and
//     r3 = 1 (falls through: r5 = r4 + r6, r7 = (rotl(r8,8) & 0xFFFFFF00) |
//     (r7 & 0xFF), r9 + 1, r10 = r11, PC 80600080). Expected values are
//     computed here from the PowerPC definitions.
// (2) White-box, RegCache directly: a deferred live-in Bind at the op's
//     top-level depth emits the load and does not poison; the same Bind from
//     inside an `if` poisons (build_block_next then rebuilds the block with
//     eager prologue loads); EmitPendingLoads loads exactly the masked
//     deferred live-ins, once.
//
// Run: node test_lazy_livein.js  (exit 0 = PASS)

#include "bementalJIT/bemental.h"
#include "guests/powerpc-next/code_op.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"
#include "guests/powerpc-next/reg_cache.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <emscripten.h>

using namespace bemental;
using namespace bemental::powerpc;

static u32 d_form(u32 opcd, u32 rt, u32 ra, u32 imm) {
    return (opcd << 26) | ((rt & 31u) << 21) | ((ra & 31u) << 16) | (imm & 0xFFFFu);
}
static u32 x31(u32 rt, u32 ra, u32 rb, u32 xo) {
    return (31u << 26) | ((rt & 31u) << 21) | ((ra & 31u) << 16) | ((rb & 31u) << 11) | (xo << 1);
}
static u32 rlwimi(u32 ra, u32 rs, u32 sh, u32 mb, u32 me) {
    return (20u << 26) | (rs << 21) | (ra << 16) | (sh << 11) | (mb << 6) | (me << 1);
}
static u32 rotl(u32 v, u32 n) { return n ? (v << n) | (v >> (32u - n)) : v; }

static int g_checks = 0, g_fails = 0;
static void expect(bool ok, const char* what) {
    ++g_checks;
    if (!ok) ++g_fails;
    std::printf("[%s] %s\n", ok ? "PASS" : "FAIL", what);
}

static void functional() {
    const u32 pc = 0x80600000u;
    const u32 insts[] = {
        d_form(11, 0, 3, 0),                         // cmpwi r3,0
        (16u << 26) | (12u << 21) | (2u << 16) | 0x3Cu,   // beq +0x3C -> 80600040
        x31(5, 4, 6, 266),                           // add r5,r4,r6
        rlwimi(7, 8, 8, 0, 23),                      // rlwimi r7,r8,8,0,23
        d_form(14, 9, 9, 1),                         // addi r9,r9,1
        x31(11, 10, 11, 444),                        // or r10,r11,r11
        (18u << 26) | 0x68u,                         // b +0x68 -> 80600080
    };
    for (u32 r3 = 0; r3 < 2; ++r3) {
        u8* raw = (u8*)std::calloc(1, 0x1400);
        const u32 ctx = (u32)(uintptr_t)raw;
        auto g = [&](u32 i) -> u32& { return *(u32*)(raw + ppc_off::gpr(i)); };
        *(u32*)(raw + ppc_off::MSR) = 0x2000u;
        for (u32 i = 0; i < 32; ++i) g(i) = 0x5A5A0000u + i * 0x01010101u;
        g(3) = r3;
        g(4) = 0x12345678u; g(6) = 0x0F0F0F0Fu;
        g(7) = 0xAABBCCDDu; g(8) = 0x11223344u;
        g(9) = 0x7FFFFFFFu; g(11) = 0xCAFEF00Du;
        u32 before[32];
        for (u32 i = 0; i < 32; ++i) before[i] = g(i);
        std::vector<u8> bytes = build_block_next(pc, insts, 7, ctx, 0, 0, 0);
        BlockCache cache;
        s32 next = -1;
        const bool ran = !bytes.empty() && cache.compile(pc, bytes.data(), bytes.size()) >= 0 &&
                         cache.dispatch(pc, &next);
        bool ok = ran;
        char what[200];
        if (r3 == 0) {
            for (u32 i = 0; i < 32; ++i) if (g(i) != before[i]) ok = false;
            ok = ok && (u32)next == 0x80600040u;
            std::snprintf(what, sizeof what, "exit before first use: next=%08x, all GPRs unchanged", (u32)next);
        } else {
            const u32 w5 = before[4] + before[6];
            const u32 w7 = (rotl(before[8], 8) & 0xFFFFFF00u) | (before[7] & 0xFFu);
            const u32 w9 = before[9] + 1u;
            const u32 w10 = before[11];
            ok = ok && g(5) == w5 && g(7) == w7 && g(9) == w9 && g(10) == w10 &&
                 (u32)next == 0x80600080u;
            for (u32 i = 0; i < 32; ++i)
                if (i != 5 && i != 7 && i != 9 && i != 10 && g(i) != before[i]) ok = false;
            std::snprintf(what, sizeof what,
                          "fall through: r5=%08x (%08x) r7=%08x (%08x) r9=%08x r10=%08x next=%08x",
                          g(5), w5, g(7), w7, g(9), g(10), (u32)next);
        }
        expect(ok, what);
        std::free(raw);
    }
}

static void white_box() {
    CodeBlock block;
    block.m_gpr_inputs = BitSet32(0);
    block.m_gpr_inputs[5] = true;
    block.m_gpr_inputs[6] = true;
    block.m_gpr_inputs[7] = true;
    const u32 ctx = 0x1000u;
    {   // top-level Bind: loads, no poison
        WasmModuleBuilder b;
        RegCache rc(b);
        rc.OnBlockEntry(block, 2u, ctx);
        bool poison = false;
        rc.SetDeferred(&poison);
        rc.SetOpDepth(b.ctrlDepth());
        const std::size_t n0 = b.size();
        { auto h = rc.Bind(5, RCMode::Read); (void)h; }
        const bool emitted = b.size() > n0;
        const std::size_t n1 = b.size();
        { auto h = rc.Bind(5, RCMode::Read); (void)h; }
        expect(!poison && emitted && b.size() == n1,
               "top-level deferred Bind: loads once, no poison");
    }
    {   // Bind inside an arm: poison
        WasmModuleBuilder b;
        RegCache rc(b);
        rc.OnBlockEntry(block, 2u, ctx);
        bool poison = false;
        rc.SetDeferred(&poison);
        rc.SetOpDepth(b.ctrlDepth());
        b.op_i32_const(1);
        b.op_if();
        { auto h = rc.Bind(6, RCMode::Read); (void)h; }
        b.op_end();
        expect(poison, "deferred Bind inside an if: poisons the build");
    }
    {   // EmitPendingLoads: exactly the masked deferred live-ins, once
        WasmModuleBuilder b;
        RegCache rc(b);
        rc.OnBlockEntry(block, 2u, ctx);
        bool poison = false;
        rc.SetDeferred(&poison);
        rc.SetOpDepth(b.ctrlDepth());
        const std::size_t n0 = b.size();
        rc.EmitPendingLoads(ctx, (1u << 5) | (1u << 9));      // r9 is not a live-in
        const std::size_t one = b.size() - n0;                 // one load = const+load+set
        rc.EmitPendingLoads(ctx, (1u << 5) | (1u << 6));       // r5 already loaded
        const std::size_t two = b.size() - n0;
        const std::size_t n2 = b.size();
        { auto h = rc.Bind(6, RCMode::Read); (void)h; }       // loaded above: no emit
        expect(!poison && one > 0 && two == 2 * one && b.size() == n2,
               "EmitPendingLoads: masked live-ins only, each once");
    }
    {   // eager mode (no SetDeferred): Bind of a live-in never emits a load
        WasmModuleBuilder b;
        RegCache rc(b);
        rc.OnBlockEntry(block, 2u, ctx);
        rc.EmitPrologueLoads(ctx);
        const std::size_t n0 = b.size();
        b.op_i32_const(1);
        b.op_if();
        { auto h = rc.Bind(7, RCMode::Read); (void)h; }
        b.op_end();
        expect(b.size() == n0 + 5, "eager mode: no load inside the arm");   // const 1 (2 B) + if (2 B) + end (1 B)
    }
}

int main() {
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        env.ppc_read8 = env.ppc_read16 = env.ppc_read32 = function(a) { return 0; };
        env.ppc_write8 = env.ppc_write16 = env.ppc_write32 = function(a, v) {};
        env.ppc_interp = function(i, p) { Module.__interp = (Module.__interp | 0) + 1; };
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
    functional();
    white_box();
    std::printf("[%s] TOTAL %d/%d checks\n", g_fails ? "FAIL" : "PASS", g_checks - g_fails, g_checks);
    return g_fails ? 1 : 0;
}
