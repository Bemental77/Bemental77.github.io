// test_superblock.cpp — BEM_LEVER_FOLLOW superblocks vs the plain block chain
// (+ the dispatch-probe diet's eviction contract and BEM_LEVER_IDLE_TAKEN).
//
// A superblock (ppc_analyst.h DecodeBlockFollow + ppc_emit.cpp CodeBlock::
// m_follow) runs the blocks the contiguous decoder would compile one after
// another as ONE wasm function, keeping GPRs in wasm locals across the joins.
// The claim is that it is indistinguishable from the plain chain at every point
// the host can observe: every slice end (downcount <= 0 at a block boundary) has
// the same PC, the same register file, the same downcount, and the same memory.
//
// The guest program (a call, a RAS-predicted return, a forward conditional exit,
// two unconditional branches and a self-loop the decoder must NOT absorb):
//
//   A 80400000  li    r3, 5
//     80400004  li    r4, 7
//     80400008  bl    F
//     8040000C  add   r6, r3, r5            <- RAS-predicted return site
//     80400010  stw   r6, 0(r7)
//     80400014  cmpwi r6, 40
//     80400018  bge   80400024             (forward conditional: mid-block exit)
//     8040001C  addi  r6, r6, 1000
//     80400020  stw   r6, 4(r7)
//     80400024  b     C
//   F 80400100  add   r5, r3, r4
//     80400104  mullw r5, r5, r4
//     80400108  lwz   r11, 8(r7)
//     8040010C  add   r5, r5, r11
//     80400110  [blr | mflr r0; li r12,4; add r0,r0,r12; mtlr r0; blr]  (RAS hit | miss)
//   C 80400200  addi  r8, r6, 1
//     80400204  stw   r8, 12(r7)
//     80400208  b     D
//   D 80400300  b     D                     (self-loop: never appended)
//
// Each arm runs from the same initial state with downcount = N for every N in
// [-1, 64] plus a large one, through the same host loop block_replay uses
// (BlockCache::chain_dispatch, compile on miss), until the first slice end or
// PC == D, and the arms' observable state is compared.
//
// Mutants this catches (each checked by hand when the test was written): no
// register flush in the seam's downcount-bail arm; no per-segment charge; the
// charge applied before the bail test; the seam bail removed.
//
// Run: node test_superblock.js  (exit 0 = PASS)

#include "bementalJIT/bemental.h"
#include "bementalJIT/block_cache.h"
#include "guests/powerpc-next/ppc_analyst.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <vector>
#include <emscripten.h>

using namespace bemental;
using namespace bemental::powerpc;

extern "C" {
extern unsigned char g_bem_chain_enabled;
}

static u32 d_form(u32 opcd, u32 rt, u32 ra, u32 imm) {
    return (opcd << 26) | (rt << 21) | (ra << 16) | (imm & 0xFFFFu);
}
static u32 x_form(u32 rt, u32 ra, u32 rb, u32 xo) {
    return (31u << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (xo << 1);
}
static u32 b_rel(u32 from, u32 to, bool lk) {
    return (18u << 26) | ((to - from) & 0x03FFFFFCu) | (lk ? 1u : 0u);
}
static u32 bc_rel(u32 bo, u32 bi, u32 from, u32 to) {
    return (16u << 26) | (bo << 21) | (bi << 16) | ((to - from) & 0xFFFCu);
}
static constexpr u32 BLR  = 0x4E800020u;
static constexpr u32 MFLR0 = 0x7C0802A6u;
static constexpr u32 MTLR0 = 0x7C0803A6u;

static std::map<u32, u32> g_code;
static u32 fetch(u32 pc, void*) {
    auto it = g_code.find(pc);
    return it == g_code.end() ? 0u : it->second;
}

// Guest RAM for the program's data accesses (mem1_base = 0 routes every access
// through these imports). Big-endian words in a JS Map keyed by address.
EM_JS(void, install_imports, (), {
    if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
    const env = Module.bemental_imports.env;
    const R = () => Module.__ram;
    const rd = (a) => (R().get(a >>> 0) | 0);
    const wr = (a, v) => { R().set(a >>> 0, v | 0); };
    env.ppc_read8 = function(a) { return (rd(a & ~3) >>> (24 - 8 * (a & 3))) & 0xFF; };
    env.ppc_read16 = function(a) { return (rd(a & ~3) >>> (16 - 8 * (a & 2))) & 0xFFFF; };
    env.ppc_read32 = function(a) { return rd(a); };
    env.ppc_write8 = function(a, v) { const s = 24 - 8 * (a & 3), w = rd(a & ~3);
        wr(a & ~3, (w & ~(0xFF << s)) | ((v & 0xFF) << s)); };
    env.ppc_write16 = function(a, v) { const s = 16 - 8 * (a & 2), w = rd(a & ~3);
        wr(a & ~3, (w & ~(0xFFFF << s)) | ((v & 0xFFFF) << s)); };
    env.ppc_write32 = function(a, v) { wr(a, v); };
    env.ppc_interp = function(i, p) { Module.__interp = (Module.__interp | 0) + 1; };
    env.ppc_check_exc = function(p) { return 0; };
    env.ppc_break_block = function(p, x) {};
    env.ppc_hle_check = function(p) { return 0; };
    env.ppc_hle_fire = function(p, i) { return 0; };
    env.ppc_stack_corrupt = function(a, b, c, d) {};
    env.ppc_msr_updated = function(m) {};
    env.ppc_gather_drain = function() {};
});
EM_JS(void, ram_reset, (), {
    Module.__ram = new Map();
    Module.__ram.set(0x80500008, 0x11);
});
EM_JS(void, ram_set, (u32 a, u32 v), { Module.__ram.set(a >>> 0, v | 0); });
EM_JS(int, ram_digest, (), {
    let h = 0x811C9DC5 | 0;
    for (const [a, v] of [...Module.__ram.entries()].sort((x, y) => x[0] - y[0])) {
        h = Math.imul(h ^ a, 16777619); h = Math.imul(h ^ v, 16777619);
    }
    return h | 0;
});

static constexpr u32 CTX_BYTES = 0x1400;
static constexpr u32 PC_A = 0x80400000u, PC_F = 0x80400100u, PC_C = 0x80400200u,
                     PC_D = 0x80400300u;

static void load_program(bool ras_miss) {
    g_code.clear();
    auto put = [](u32 pc, u32 w) { g_code[pc] = w; };
    put(0x80400000u, d_form(14, 3, 0, 5));
    put(0x80400004u, d_form(14, 4, 0, 7));
    put(0x80400008u, b_rel(0x80400008u, PC_F, true));
    put(0x8040000Cu, x_form(6, 3, 5, 266));                 // add r6,r3,r5
    put(0x80400010u, d_form(36, 6, 7, 0));                  // stw r6,0(r7)
    put(0x80400014u, d_form(11, 0, 6, 40));                 // cmpwi r6,40
    put(0x80400018u, bc_rel(4, 0, 0x80400018u, 0x80400024u));  // bge
    put(0x8040001Cu, d_form(14, 6, 6, 1000));
    put(0x80400020u, d_form(36, 6, 7, 4));
    put(0x80400024u, b_rel(0x80400024u, PC_C, false));
    put(0x80400100u, x_form(5, 3, 4, 266));                 // add r5,r3,r4
    put(0x80400104u, x_form(5, 5, 4, 235));                 // mullw r5,r5,r4
    put(0x80400108u, d_form(32, 11, 7, 8));                 // lwz r11,8(r7)
    put(0x8040010Cu, x_form(5, 5, 11, 266));                // add r5,r5,r11
    if (!ras_miss) {
        put(0x80400110u, BLR);
    } else {
        // r0 = LR + 4 (addi with rA=0 is `li`, hence the r12 detour)
        put(0x80400110u, MFLR0);
        put(0x80400114u, d_form(14, 12, 0, 4));                // li r12,4
        put(0x80400118u, x_form(0, 0, 12, 266));               // add r0,r0,r12
        put(0x8040011Cu, MTLR0);
        put(0x80400120u, BLR);
    }
    put(0x80400200u, d_form(14, 8, 6, 1));
    put(0x80400204u, d_form(36, 8, 7, 12));
    put(0x80400208u, b_rel(0x80400208u, PC_D, false));
    put(0x80400300u, b_rel(0x80400300u, PC_D, false));
}

struct Obs {
    u32 pc = 0;
    s32 dc = 0;
    u64 ctx_hash = 0;
    s32 ram = 0;
    u32 compiles = 0;
};

static u64 fnv(const u8* p, std::size_t n, u64 h) {
    for (std::size_t i = 0; i < n; ++i) { h ^= p[i]; h *= 1099511628211ull; }
    return h;
}

// One arm: run from PC_A with downcount dc0 until the first slice end or PC_D.
// evict_pcs: run once to PC_D, evict those blocks (BlockCache::evict, the SMC /
// deopt path), reset ctx + RAM, and run again on the SAME cache. Every probe
// into an evicted block must miss (host return + recompile), never call it.
static Obs run_arm(bool follow, s32 dc0, const std::vector<u32>& evict_pcs = {}) {
    u8* ctx = (u8*)std::calloc(1, CTX_BYTES + 0x100);
    const u32 ctx_ptr = (u32)(uintptr_t)ctx;
    auto w32 = [&](u32 off, u32 v) { std::memcpy(ctx + off, &v, 4); };
    auto r32 = [&](u32 off) { u32 v; std::memcpy(&v, ctx + off, 4); return v; };
    auto reset = [&]() {
        std::memset(ctx, 0, CTX_BYTES);
        for (u32 i = 0; i < 32; ++i) w32(ppc_off::gpr(i), 0xAAAA0000u + i);
        w32(ppc_off::gpr(7), 0x80500000u);
        w32(ppc_off::MSR, 0x2000u);
        w32(ppc_off::PC, PC_A);
        w32(ppc_off::NPC, PC_A);
        w32(ppc_off::DOWNCOUNT, (u32)dc0);
        ram_reset();
    };
    reset();
    Obs o;
    {
        BlockCache cache;
        for (int pass = 0; pass < (evict_pcs.empty() ? 1 : 2); ++pass) {
        if (pass == 1) {
            for (u32 e : evict_pcs) cache.evict(e);
            reset();
            o.compiles = 0;
        }
        for (int guard = 0; guard < 4096; ++guard) {
            const u32 pc = r32(ppc_off::PC);
            if (pc == PC_D) break;
            u32 final_pc = pc, trap_pc = 0;
            const s32 n = cache.chain_dispatch(
                pc, 4096u, &final_pc, &trap_pc,
                reinterpret_cast<const u32*>(ctx + ppc_off::EXCEPTIONS),
                reinterpret_cast<const s32*>(ctx + ppc_off::DOWNCOUNT));
            if (trap_pc) { std::printf("[FAIL] trap at %08x\n", trap_pc); o.pc = 0xDEAD; break; }
            if (n > 0) {
                w32(ppc_off::PC, final_pc);
                w32(ppc_off::NPC, final_pc);
                if ((s32)r32(ppc_off::DOWNCOUNT) <= 0) break;
                continue;
            }
            u32 insts[64], pcs[64], nseams = 0;
            std::size_t cnt = 0;
            if (follow)
                cnt = DecodeBlockFollow(pc, fetch, nullptr, insts, pcs, 64, &nseams,
                                        nullptr, nullptr, 0u, nullptr);
            if (nseams == 0) {
                cnt = 0;
                for (u32 p = pc; cnt < 64; p += 4) {
                    insts[cnt++] = fetch(p, nullptr);
                    if (IsBlockTerminator(insts[cnt - 1]) &&
                        !IsForwardConditionalBranch(insts[cnt - 1], p)) break;
                }
            }
            std::vector<u8> bytes = build_block_next(
                pc, insts, (u32)cnt, ctx_ptr, 0, 0, 0, nullptr, nullptr,
                nseams ? pcs : nullptr, nseams ? BEM_BUILD_FOLLOW : 0u);
            if (bytes.empty() || cache.compile(pc, bytes.data(), bytes.size()) < 0) {
                std::printf("[FAIL] compile at %08x\n", pc); o.pc = 0xDEAD; break;
            }
            ++o.compiles;
        }
        if (o.pc == 0xDEAD) break;
        }
    }
    if (o.pc != 0xDEAD) {
        o.pc = r32(ppc_off::PC);
        o.dc = (s32)r32(ppc_off::DOWNCOUNT);
        o.ctx_hash = fnv(ctx + 0x14, ppc_off::DOWNCOUNT - 0x14, 1469598103934665603ull);
        o.ctx_hash = fnv(ctx + 0x2F4, 0x1340 - 0x2F4, o.ctx_hash);
        o.ram = ram_digest();
    }
    std::free(ctx);
    return o;
}

int main() {
    install_imports();
    g_hle_hook_query = [](uint32_t) -> bool { return false; };
    g_bem_chain_enabled = 1u;
    int fails = 0, checks = 0;
    auto expect = [&](bool c, const char* what) {
        ++checks;
        if (!c) { ++fails; std::printf("[FAIL] %s\n", what); }
    };

    // ---- decoder structure ------------------------------------------------
    load_program(false);
    {
        u32 insts[64], pcs[64], nseams = 0, lo[64], hi[64], nsp = 0;
        const std::size_t n = DecodeBlockFollow(PC_A, fetch, nullptr, insts, pcs, 64, &nseams,
                                                lo, hi, 64, &nsp);
        // A(3) + F(5) + R(7) + C(3); D (self-loop) is not appended.
        expect(n == 18u, "follow stream length 18 (A+F+R+C)");
        expect(nseams == 3u, "3 seams (bl, blr, b)");
        expect(nsp == 4u && lo[0] == PC_A && lo[1] == PC_F && lo[2] == 0x8040000Cu && lo[3] == PC_C,
               "segment spans A, F, return site, C");
        expect(n == 18u && pcs[17] == 0x80400208u, "stream ends on C's `b D` (self-loop D left out)");
        u32 n2 = 0;
        DecodeBlockFollow(PC_A, fetch, nullptr, insts, pcs, 10, &n2, nullptr, nullptr, 0, nullptr);
        expect(n2 == 1u, "cap 10: only F fits after A (segments are never cut)");
        DecodeBlockFollow(PC_D, fetch, nullptr, insts, pcs, 64, &n2, nullptr, nullptr, 0, nullptr);
        expect(n2 == 0u, "self-loop block D: no seams");
    }

    // ---- differential: plain chain vs superblock, every slice end ----------
    for (int variant = 0; variant < 2; ++variant) {
        load_program(variant == 1);
        int equal = 0, total = 0, sb_compiles = 0, plain_compiles = 0;
        for (s32 dc0 = -1; dc0 <= 65; ++dc0) {
            const s32 dc = dc0 == 65 ? 100000 : dc0;
            const Obs a = run_arm(false, dc);
            const Obs b = run_arm(true, dc);
            plain_compiles += a.compiles; sb_compiles += b.compiles;
            ++total;
            const bool same = a.pc == b.pc && a.dc == b.dc && a.ctx_hash == b.ctx_hash &&
                              a.ram == b.ram && a.pc != 0xDEAD;
            if (same) { ++equal; continue; }
            std::printf("  [diff] variant=%d dc0=%d plain pc=%08x dc=%d ctx=%016llx ram=%08x | "
                        "super pc=%08x dc=%d ctx=%016llx ram=%08x\n", variant, dc,
                        a.pc, a.dc, (unsigned long long)a.ctx_hash, (u32)a.ram,
                        b.pc, b.dc, (unsigned long long)b.ctx_hash, (u32)b.ram);
        }
        char what[160];
        std::snprintf(what, sizeof what, "variant %s: %d/%d slice ends identical",
                      variant ? "ras-miss" : "ras-hit", equal, total);
        expect(equal == total, what);
        std::printf("[%s] %s (compiles plain=%d superblock=%d)\n", equal == total ? "PASS" : "FAIL",
                    what, plain_compiles, sb_compiles);
        expect(sb_compiles < plain_compiles, "superblock arm compiled fewer blocks");
    }
    // The ras-hit run must reach D with the full program's result.
    load_program(false);
    {
        const Obs b = run_arm(true, 100000);
        expect(b.pc == PC_D, "superblock run reaches D");
    }
    // Eviction: re-running after evicting blocks that other blocks chain to
    // (statically: C from R's `b C`; at runtime: R from F's blr) must miss,
    // recompile exactly the evicted blocks, and end in the same state. A probe
    // that trusts a bucket without its tag compare calls a freed table slot.
    for (int f = 0; f < 2; ++f) {
        const Obs ref = run_arm(f == 1, 100000);
        const std::vector<u32> ev = f ? std::vector<u32>{PC_A}
                                      : std::vector<u32>{0x8040000Cu, PC_C};
        const Obs b = run_arm(f == 1, 100000, ev);
        char what[128];
        std::snprintf(what, sizeof what, "%s: evict + rerun = same state, %u recompiles",
                      f ? "superblock" : "plain", b.compiles);
        const bool ok = b.pc == ref.pc && b.dc == ref.dc && b.ctx_hash == ref.ctx_hash &&
                        b.ram == ref.ram && b.compiles == (u32)ev.size();
        expect(ok, what);
        std::printf("[%s] %s\n", ok ? "PASS" : "FAIL", what);
    }

    // ---- BEM_LEVER_IDLE_TAKEN: the idle skip happens on the taken back-edge ----
    //   P 80400400  lwz   r0, 0(r7)      a poll: Load + Integer + branch to self
    //     80400404  cmpwi r0, 0           => the analyzer classifies it idle
    //     80400408  bgt   P
    //     8040040C  b     D
    // Poll word 0: the loop falls through at once. That is an ordinary block
    // exit: the block's cycles are charged and the run continues to D; it must
    // NOT end the slice with downcount = 0 (a clock-jump to the next event for a
    // loop that never spun). Poll word 1: the loop is taken; the slice ends at P
    // with downcount = 0, as it always did.
    for (int spin = 0; spin < 2; ++spin) {
        g_code.clear();
        const u32 P = 0x80400400u;
        g_code[P]       = d_form(32, 0, 7, 0);
        g_code[P + 4]   = d_form(11, 0, 0, 0);
        g_code[P + 8]   = bc_rel(12, 1, P + 8, P);     // bgt cr0 -> P
        g_code[P + 12]  = b_rel(P + 12, PC_D, false);
        g_code[PC_D]    = b_rel(PC_D, PC_D, false);
        {
            u32 one[3] = {g_code[P], g_code[P + 4], g_code[P + 8]};
            bool idle = false;
            u32 cyc = 0;
            build_block_next(P, one, 3, 0x1000u, 0, 0, 0, &cyc, &idle);
            expect(idle, "poll block classified idle");
        }
        u8* ctx = (u8*)std::calloc(1, CTX_BYTES + 0x100);
        const u32 ctx_ptr = (u32)(uintptr_t)ctx;
        auto w32 = [&](u32 off, u32 v) { std::memcpy(ctx + off, &v, 4); };
        auto r32 = [&](u32 off) { u32 v; std::memcpy(&v, ctx + off, 4); return v; };
        w32(ppc_off::gpr(7), 0x80500000u);
        w32(ppc_off::MSR, 0x2000u);
        w32(ppc_off::PC, P);
        w32(ppc_off::DOWNCOUNT, 1000u);
        ram_reset();
        ram_set(0x80500000u, spin ? 1u : 0u);
        {
            BlockCache cache;
            for (int guard = 0; guard < 64; ++guard) {
                const u32 pc = r32(ppc_off::PC);
                if (pc == PC_D) break;
                u32 final_pc = pc, trap_pc = 0;
                const s32 n = cache.chain_dispatch(
                    pc, 4096u, &final_pc, &trap_pc,
                    reinterpret_cast<const u32*>(ctx + ppc_off::EXCEPTIONS),
                    reinterpret_cast<const s32*>(ctx + ppc_off::DOWNCOUNT));
                if (n > 0) {
                    w32(ppc_off::PC, final_pc);
                    if ((s32)r32(ppc_off::DOWNCOUNT) <= 0) break;
                    continue;
                }
                u32 w[64]; u32 cnt = 0;
                for (u32 p2 = pc; cnt < 64; p2 += 4) {
                    w[cnt++] = fetch(p2, nullptr);
                    if (IsBlockTerminator(w[cnt - 1]) && !IsForwardConditionalBranch(w[cnt - 1], p2)) break;
                }
                std::vector<u8> bytes = build_block_next(pc, w, cnt, ctx_ptr, 0, 0, 0);
                if (bytes.empty() || cache.compile(pc, bytes.data(), bytes.size()) < 0) break;
            }
        }
        const u32 pc = r32(ppc_off::PC);
        const s32 dc = (s32)r32(ppc_off::DOWNCOUNT);
        char what[128];
        const bool ok = spin ? (pc == P && dc == 0) : (pc == PC_D && dc > 0 && dc < 1000);
        std::snprintf(what, sizeof what, "idle poll %s: pc=%08x downcount=%d", spin ? "spins" : "falls through", pc, dc);
        expect(ok, what);
        std::printf("[%s] %s\n", ok ? "PASS" : "FAIL", what);
        std::free(ctx);
    }

    std::printf("[%s] TOTAL %d/%d checks\n", fails ? "FAIL" : "PASS", checks - fails, checks);
    return fails ? 1 : 0;
}
