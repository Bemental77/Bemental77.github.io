// aot_compile.cpp — [AOT A1] the offline compiler MVP. Links bementalJITPowerPCNext
// NATIVELY and runs build_block_next on a guest function's bytes at BUILD time, writing
// the emitted wasm modules as a .bjaot asset. At boot the runtime streams the asset and
// registers each block at its PC bucket (the template-pilot hash-matched machine) instead
// of JIT-compiling it — the AOT integration path proven at one-function granularity.
//
// A1 target = PSMTXROMultVecArray (0x800bc8d0), the software-pipelined skinning nest that
// already has goldens (26/26) + fixture + shadow-verify built this campaign. A1 proves the
// PIPELINE, not fps (the fn is ~1.6% of samples; fps delta pre-registered ≈0).
//
// MVP codegen note: build_block_next BAKES ctx_ptr + mem1_base as constants. For the MVP
// we emit with mem1_base=0 (slowmem — address-independent, routes memory through the host
// ppc_read/write imports; the golden harness run_psmtxro proved PSMTX correct this way) and
// a ctx_ptr passed on the CLI so the boot loader/validator agrees on the PowerPCState
// address. §6.1 ctx→locals parameterization (fully relocatable, no baking) is A3's job.
//
// Build (native): see gamecube/bementalJIT/tools/build_aot.sh.
// Run: aot_compile <ctx_ptr_hex> <out.bjaot>   (ctx_ptr default 0 = placeholder)

#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_analyst.h"  // IsBlockTerminator / IsForwardConditionalBranch

#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <vector>

using namespace bemental;
using namespace bemental::powerpc;

// Emit-affecting globals (defined in block_cache.cpp). The live JitWasm::Run
// sets g_bem_lc_base to Memory::GetL1Cache(); to reproduce the live emit
// byte-for-byte offline we must set the same value here. fprf/accurate_nans
// default 0 and match the live MP4 (GMPE01) config.
extern "C" { extern uint32_t g_bem_lc_base; extern uint32_t g_bem_fprf_enabled; extern uint32_t g_bem_accurate_nans; }

// PSMTXROMultVecArray, byte-exact from the MP4 decomp (psmtx.s); mirrors
// test_gekko_next.cpp:kPSMTXRO. Entry 0x800bc8d0, blr at 0x800bc9e4.
static const uint32_t kPSMTXRO[70] = {
    0x9421ffc0, 0xd9c10008, 0x38e6ffff, 0xd9e10010, 0x54e7f87e, 0xda010018,
    0xda210020, 0xda410028, 0x7ce903a6, 0xe0030000, 0x3884fff8, 0xe0238008,
    0x38a5fffc, 0xe0c30024, 0xe5040008, 0xe0e3802c, 0xe5240008, 0x1160321c,
    0xe043000c, 0x11813a1c, 0xe0638014, 0x11a0325e, 0xe5440008, 0x11c13a5e,
    0xe0a38020, 0x11625a1e, 0x1183621e, 0xe0830018, 0x11a26a9c, 0xe5040008,
    0x11c3729c, 0x11e45a5c, 0x1205625c, 0xe5240008, 0x12246a9e, 0x1245729e,
    0xe5440008, 0x1160321c, 0xf5e50004, 0x11813a1c, 0xf6058008, 0x11a0325e,
    0xf6250004, 0x11c13a5e, 0xf6458008, 0x11625a1e, 0x1183621e, 0xe5040008,
    0x11a26a9c, 0x11c3729c, 0x11e45a5c, 0x1205625c, 0xe5240008, 0x12246a9e,
    0x1245729e, 0xe5440008, 0x4200ffb4, 0xf5e50004, 0x54c707ff, 0xf6058008,
    0x4082000c, 0xf6250004, 0xf6458008, 0xc9c10008, 0xc9e10010, 0xca010018,
    0xca210020, 0xca410028, 0x38210040, 0x4e800020,
};
static const uint32_t kEntry = 0x800bc8d0u;
// The 5 block starts the JIT splits this function into (run_psmtxro's kStarts).
static const uint32_t kStarts[] = {0x800bc8d0u, 0x800bc964u, 0x800bc9b4u, 0x800bc9c4u, 0x800bc9ccu};

static void put_u32(std::vector<uint8_t>& v, uint32_t x) {
    v.push_back(x & 0xFF); v.push_back((x >> 8) & 0xFF);
    v.push_back((x >> 16) & 0xFF); v.push_back((x >> 24) & 0xFF);
}

int main(int argc, char** argv) {
    const uint32_t ctx_ptr = (argc > 1) ? (uint32_t)strtoul(argv[1], nullptr, 0) : 0u;
    const char* out_path   = (argc > 2) ? argv[2] : "psmtxro.bjaot";
    // argv[3] = live g_bem_lc_base (Memory::GetL1Cache()), so the offline emit
    // matches the live JIT context. 0 = leave default (diagnostic).
    g_bem_lc_base = (argc > 3) ? (uint32_t)strtoul(argv[3], nullptr, 0) : 0u;

    // Match the live JIT context (JitWasm::Init sets this): a null query makes
    // the emitter conservatively wrap EVERY op in Flush + HLE prologue (bigger
    // emit); the live path + goldens install a query returning false for
    // un-hooked PCs. PSMTXROMultVecArray is a math routine, never HLE-hooked.
    g_hle_hook_query = [](uint32_t) -> bool { return false; };

    struct Blk { uint32_t pc; uint32_t gcount; uint32_t ghash; uint32_t cycles; std::vector<uint32_t> gwords; std::vector<uint8_t> wasm; };
    std::vector<Blk> blocks;
    for (uint32_t s : kStarts) {
        const uint32_t idx = (s - kEntry) >> 2;
        // Compute the EXACT block guest span the live JitWasm decoder produces
        // (JitWasm.cpp:654-671): scan until a terminator that is NOT a coalescable
        // forward conditional (inclusive). This is the `count` the runtime will
        // hash — it must match the live decode, not the naive 70-idx.
        uint32_t gcount = 0;
        for (uint32_t j = idx; j < 70u; ++j) {
            const uint32_t inst = kPSMTXRO[j];
            const uint32_t pc = s + (j - idx) * 4u;
            ++gcount;
            if (IsBlockTerminator(inst) && !IsForwardConditionalBranch(inst, pc)) break;
        }
        // Emit with the same count the golden harness uses (70-idx); build_block_next
        // stops at the terminator internally, so the emitted block is span-bounded.
        // instr_pcs=nullptr + g_hle_hook_query=false match the golden/live context.
        uint32_t cyc = 0;
        std::vector<uint8_t> w = build_block_next(
            s, &kPSMTXRO[idx], 70u - idx, ctx_ptr,
            /*mem1_base=*/0u, /*mem1_mask=*/0u, /*ram_size=*/0u,
            /*out_cycles=*/&cyc, /*out_is_idle_loop=*/nullptr, /*instr_pcs=*/nullptr);
        const bool ok = w.size() >= 8 && w[0] == 0x00 && w[1] == 0x61 &&
                        w[2] == 0x73 && w[3] == 0x6D;
        // FNV-1a over the block's guest instruction words = the registration hash.
        std::vector<uint32_t> gwords(kPSMTXRO + idx, kPSMTXRO + idx + gcount);
        uint32_t h = 0x811c9dc5u;
        for (uint32_t gw : gwords) { for (int k = 0; k < 4; ++k) { h ^= (gw >> (8 * k)) & 0xFFu; h *= 0x01000193u; } }
        std::printf("  block 0x%08x: %zu wasm bytes  gspan=%u  ghash=0x%08x  cycles=%u  magic=%s\n",
                    s, w.size(), gcount, h, cyc, ok ? "OK" : "BAD");
        if (!ok) { std::fprintf(stderr, "[aot] block 0x%08x emitted invalid wasm\n", s); return 2; }
        blocks.push_back({s, gcount, h, cyc, std::move(gwords), std::move(w)});
    }

    // Asset v2: "BJAOT"\0 | ver=2 u32 | baked_ctx u32 | n u32
    //   | n*(pc u32, gspan u32, ghash u32, cycles u32, wasm_len u32)
    //   | for each block: gspan * (guest word u32)
    //   | for each block: wasm bytes
    std::vector<uint8_t> asset;
    const char magic[6] = {'B','J','A','O','T','\0'};
    asset.insert(asset.end(), magic, magic + 6);
    put_u32(asset, 2u);            // version
    put_u32(asset, ctx_ptr);       // baked ctx this asset's blocks assume
    put_u32(asset, (uint32_t)blocks.size());
    for (auto& b : blocks) { put_u32(asset, b.pc); put_u32(asset, b.gcount); put_u32(asset, b.ghash); put_u32(asset, b.cycles); put_u32(asset, (uint32_t)b.wasm.size()); }
    for (auto& b : blocks) for (uint32_t gw : b.gwords) put_u32(asset, gw);
    for (auto& b : blocks) asset.insert(asset.end(), b.wasm.begin(), b.wasm.end());

    FILE* f = std::fopen(out_path, "wb");
    if (!f) { std::perror("fopen"); return 1; }
    std::fwrite(asset.data(), 1, asset.size(), f);
    std::fclose(f);
    std::printf("[aot] wrote %s (v2): %zu blocks, %zu total bytes, baked_ctx=0x%08x\n",
                out_path, blocks.size(), asset.size(), ctx_ptr);
    return 0;
}
