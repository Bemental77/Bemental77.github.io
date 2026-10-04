// test_mem_slowarm.cpp — host-observed state at slow-arm memory imports.
//
// BEM_LEVER_MEM_SLOWARM (lever_gate.h) moves two things out of the common path
// of every integer load/store and into the slow arms' host calls: the pre-op
// `ctx.PC = op.address` store and the RegCache flush of dirty GPRs. The claim
// is that the HOST observes byte-identical ctx.PC and gpr[] at every import
// call. This test makes the imports record what they see and checks it:
//
//   0x80300000  li   r5, 0x1234      r5 dirty (compile-time immediate)
//   0x80300004  stw  r5, 0(r3)       r3 = 0xCC006000 -> slow arm -> ppc_write32
//   0x80300008  li   r7, 0x55        r7 dirty
//   0x8030000C  lwz  r8, 4(r3)       slow arm -> ppc_read32; r8 not yet written
//   0x80300010  addi r9, r8, 1       uses the loaded value
//   0x80300014  stb  r9, 8(r3)       slow arm -> ppc_write8
//   0x80300018  ori  r0, r0, 0       (cap terminator)
//
// At ppc_write32: PC == 0x80300004, gpr5 == 0x1234.
// At ppc_read32:  PC == 0x8030000C, gpr7 == 0x55, gpr8 == its PRE-load value.
// At ppc_write8:  PC == 0x80300014, gpr8 == loaded value, gpr9 == loaded + 1.
// After the block: gpr5/7/8/9 architecturally correct.
// Run: node test_mem_slowarm.js  (exit 0 = PASS)

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

static u32 d_form(u32 opcd, u32 rt, u32 ra, u32 imm) {
    return (opcd << 26) | (rt << 21) | (ra << 16) | (imm & 0xFFFFu);
}

EM_JS(void, install_imports, (u32 ctx_in, u32 pc_off, u32 g_off), {
    if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
    const env = Module.bemental_imports.env;
    const ctx = ctx_in >>> 0, PC = pc_off >>> 0, G = g_off >>> 0;
    const snap = (tag) => {
        const r = { tag: tag, pc: HEAPU32[(ctx + PC) >> 2] };
        for (const n of [5, 7, 8, 9]) r['r' + n] = HEAPU32[(ctx + G + 4 * n) >> 2];
        (Module.__seen = Module.__seen || []).push(r);
    };
    env.ppc_read8 = function(a) { return 0; };
    env.ppc_read16 = function(a) { return 0; };
    env.ppc_read32 = function(a) { snap('r32'); return 0x0BADF00D; };
    env.ppc_write8 = function(a, v) { snap('w8'); };
    env.ppc_write16 = function(a, v) {};
    env.ppc_write32 = function(a, v) { snap('w32'); };
    env.ppc_interp = function(i, p) {};
    env.ppc_check_exc = function(p) { return 0; };
    env.ppc_break_block = function(p, x) {};
    env.ppc_hle_check = function(p) { return 0; };
    env.ppc_hle_fire = function(p, i) { return 0; };
    env.ppc_stack_corrupt = function(a, b, c, d) {};
    env.ppc_msr_updated = function(m) {};
    env.ppc_gather_drain = function() {};
});

EM_JS(int, check_seen, (), {
    const s = Module.__seen || [];
    const want = [
        { tag: 'w32', pc: 0x80300004, r5: 0x1234 },
        { tag: 'r32', pc: 0x8030000C, r5: 0x1234, r7: 0x55, r8: 0xAAAA0008 },
        { tag: 'w8',  pc: 0x80300014, r5: 0x1234, r7: 0x55, r8: 0x0BADF00D, r9: 0x0BADF00E },
    ];
    const hex = (v) => typeof v === 'number' ? (v >>> 0).toString(16) : String(v);
    let good = s.length === want.length;
    for (let i = 0; i < want.length; i++) {
        const g = s[i] || {};
        for (const k of Object.keys(want[i])) {
            const w = want[i][k];
            const pass = typeof w === 'number' ? ((g[k] >>> 0) === (w >>> 0)) : g[k] === w;
            if (!pass) { good = false; console.log('  [mismatch] call ' + i + ' ' + k + ' got=' + hex(g[k]) + ' want=' + hex(w)); }
        }
    }
    console.log('[mem-slowarm] host saw: ' + JSON.stringify(s.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, hex(v)])))));
    return good ? 1 : 0;
});

int main() {
    constexpr u32 CTX_BYTES = 0x1400;
    u8* ctx = (u8*)std::calloc(1, CTX_BYTES);
    const u32 ctx_ptr = (u32)(uintptr_t)ctx;
    auto gpr = [&](u32 i) -> u32& { return *(u32*)(ctx + ppc_off::gpr(i)); };
    for (u32 i = 0; i < 32; ++i) gpr(i) = 0xAAAA0000u + i;
    gpr(3) = 0xCC006000u;
    *(u32*)(ctx + ppc_off::MSR) = 0x2000u;

    install_imports(ctx_ptr, ppc_off::PC, ppc_off::gpr(0));

    // No HLE hooks (the live JitWasm installs a real query). With the default
    // null query EVERY op gets the conservative HLE prologue, whose own
    // rc.Flush would mask exactly the GPR flush this test exists to check.
    g_hle_hook_query = [](uint32_t) -> bool { return false; };

    const u32 PCB = 0x80300000u;
    const u32 insts[] = {
        d_form(14, 5, 0, 0x1234),        // li r5, 0x1234
        d_form(36, 5, 3, 0),             // stw r5, 0(r3)
        d_form(14, 7, 0, 0x55),          // li r7, 0x55
        d_form(32, 8, 3, 4),             // lwz r8, 4(r3)
        d_form(14, 9, 8, 1),             // addi r9, r8, 1
        d_form(38, 9, 3, 8),             // stb r9, 8(r3)
        d_form(24, 0, 0, 0),             // ori r0, r0, 0
    };
    BlockCache cache;
    std::vector<u8> bytes = build_block_next(PCB, insts, 7, ctx_ptr, 0, 0, 0);
    if (cache.compile(PCB, bytes.data(), bytes.size()) < 0) { std::printf("[FAIL] compile\n"); return 1; }
    s32 next = -1;
    if (!cache.dispatch(PCB, &next)) { std::printf("[FAIL] dispatch\n"); return 1; }

    const int ok = check_seen();
    const bool arch_ok = gpr(5) == 0x1234u && gpr(7) == 0x55u && gpr(8) == 0x0BADF00Du && gpr(9) == 0x0BADF00Eu;
    std::printf("[%s] host-observed PC/gpr at slow-arm imports\n", ok ? "PASS" : "FAIL");
    std::printf("[%s] post-block gpr r5=%08x r7=%08x r8=%08x r9=%08x\n", arch_ok ? "PASS" : "FAIL",
                gpr(5), gpr(7), gpr(8), gpr(9));
    const bool pass = ok && arch_ok;
    std::printf("[%s] TOTAL\n", pass ? "PASS" : "FAIL");
    std::free(ctx);
    return pass ? 0 : 1;
}
