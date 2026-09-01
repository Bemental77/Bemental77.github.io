// test_pi_mask_path.cpp — repro for the SAB PI-mask-write miscompilation.
//
// Plays back the exact instruction bytes from SAB DOL at 0x800e7bbc..0x800e7c70
// (the cntlzw=17 path of the OS-mask → PI-mask translator) with a known input
// state. Real game write at 0x800e7c68 was observed as r5=0; static-trace says
// r5 must be ≥0xf0 (in the actual probe with r4=0xffffffe0, expected = 0x77FF).
// If the JIT here also writes 0, the bug is reproducible in isolation and the
// fix lives in gekko_emit.cpp without V8/Dolphin overhead.

#include "bementalJIT/bemental.h"
#include "guests/powerpc/gekko_emit.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

#endif

using namespace bemental;
using namespace bemental::powerpc;

// Bytes from SAB DOL at 0x800e7bbc..0x800e7c70 (PI-mask compute + write + blr).
// 46 instructions. With r3=0x7fe0 (cntlzw=17) and r4=0xffffffe0, the path
// computes r5 = 0xf0 (base from `addi r5, r0, 240` with PPC RA=0 literal-zero)
// + ORs in {0x8 SI, 0x4 DI, 0x2 RSW, 0x1 PI, 0x100 VI, 0x1000 DEBUG, 0x200
// PE_TOKEN, 0x400 PE_FINISH, 0x2000 HSP} = 0x77FF, then `stw r5, 4(r4)` to
// PI_INTERRUPT_MASK, `rlwinm r3,r3,0,27,16` (clears r3 bits processed), blr.
static const u32 PI_MASK_PATH[] = {
    0x54800462u, // 0x800e7bbc  rlwinm r0,r4,0,17,17
    0x28000000u, // 0x800e7bc0  cmplwi r0,0
    0x38a000f0u, // 0x800e7bc4  addi r5,r0,240         <-- r5 ≥ 0xf0 starts here
    0x40820008u, // 0x800e7bc8  bc 4,2,+8
    0x60a50800u, // 0x800e7bcc  ori r5,r5,0x800
    0x54800528u, // 0x800e7bd0  rlwinm r0,r4,0,20,20
    0x28000000u, // 0x800e7bd4  cmplwi r0,0
    0x40820008u, // 0x800e7bd8  bc 4,2,+8
    0x60a50008u, // 0x800e7bdc  ori r5,r5,0x8
    0x5480056au, // 0x800e7be0  rlwinm r0,r4,0,21,21
    0x28000000u, // 0x800e7be4
    0x40820008u, // 0x800e7be8
    0x60a50004u, // 0x800e7bec  ori r5,r5,0x4
    0x548005acu, // 0x800e7bf0
    0x28000000u, // 0x800e7bf4
    0x40820008u, // 0x800e7bf8
    0x60a50002u, // 0x800e7bfc  ori r5,r5,0x2
    0x548005eeu, // 0x800e7c00
    0x28000000u, // 0x800e7c04
    0x40820008u, // 0x800e7c08
    0x60a50001u, // 0x800e7c0c  ori r5,r5,0x1
    0x54800630u, // 0x800e7c10
    0x28000000u, // 0x800e7c14
    0x40820008u, // 0x800e7c18
    0x60a50100u, // 0x800e7c1c  ori r5,r5,0x100
    0x54800672u, // 0x800e7c20
    0x28000000u, // 0x800e7c24
    0x40820008u, // 0x800e7c28
    0x60a51000u, // 0x800e7c2c  ori r5,r5,0x1000
    0x548004a4u, // 0x800e7c30
    0x28000000u, // 0x800e7c34
    0x40820008u, // 0x800e7c38
    0x60a50200u, // 0x800e7c3c  ori r5,r5,0x200
    0x548004e6u, // 0x800e7c40
    0x28000000u, // 0x800e7c44
    0x40820008u, // 0x800e7c48
    0x60a50400u, // 0x800e7c4c  ori r5,r5,0x400
    0x548006b4u, // 0x800e7c50
    0x28000000u, // 0x800e7c54
    0x40820008u, // 0x800e7c58
    0x60a52000u, // 0x800e7c5c  ori r5,r5,0x2000
    0x3c80cc00u, // 0x800e7c60  lis r4,0xcc00
    0x38843000u, // 0x800e7c64  addi r4,r4,0x3000      <-- r4 = 0xCC003000 (clobbers OS-mask r4!)
    0x90a40004u, // 0x800e7c68  stw r5,4(r4)            <-- stw the computed mask
    0x546306e0u, // 0x800e7c6c  rlwinm r3,r3,0,27,16
    0x4e800020u, // 0x800e7c70  blr                     <-- block end
};
static constexpr u32 PI_MASK_PATH_LEN = sizeof(PI_MASK_PATH) / sizeof(PI_MASK_PATH[0]);

static constexpr u32 GUEST_MEM_BASE = 0x80000000u;
static constexpr u32 GUEST_MEM_SIZE = 0x00400000u;
static constexpr u32 LOAD_PC        = 0x80003100u;
static constexpr u32 SENTINEL_LR    = 0xDEADBEEFu;

// Block walker — same shape as test_perf_t1's decode_block.
static u32 decode_block(const u32* guest_mem, u32 pc, u32* out_inst, u32 max_inst) {
    const u32 base_word_idx = (pc - GUEST_MEM_BASE) / 4u;
    u32 i = 0;
    for (; i < max_inst; ++i) {
        const u32 inst = guest_mem[base_word_idx + i];
        out_inst[i] = inst;
        const u32 op = (inst >> 26) & 0x3Fu;
        if (op == 16 || op == 17 || op == 18 || op == 19) {
            ++i;
            break;
        }
    }
    return i;
}
// [completion-marker 2026-09-01] run_browser_test.mjs grants a PASS only when a
// suite prints its own end-of-run line. These four suites had none, so a run cut
// short mid-suite was indistinguishable from one that finished, and the harness
// reported PASS off the first passing case.
static inline void bem_test_total(int passed, int failed) {
    std::printf("TOTAL: %d passed, %d failed\n", passed, failed);
#ifdef __EMSCRIPTEN__
    EM_ASM({ console.log('TOTAL: ' + $0 + ' passed, ' + $1 + ' failed'); }, passed, failed);
#endif
}


int main() {
#ifdef __EMSCRIPTEN__
    // Bind host imports to the WASM module before any block instantiates.
    // ppc_write32 to 0xCC003004 (PI mask) lands outside MEM1 — we capture it
    // here so we can read what r5 was at the stw moment.
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        env.ppc_read8       = function(a)    { return (Module.HEAPU8[a - 0x80000000 + Module._test_mem1_host] | 0); };
        env.ppc_read16      = function(a)    { const o = (a - 0x80000000 + Module._test_mem1_host) | 0; return (Module.HEAPU16[o >> 1] | 0); };
        env.ppc_read32      = function(a)    { const o = (a - 0x80000000 + Module._test_mem1_host) | 0; return (Module.HEAPU32[o >> 2] | 0); };
        env.ppc_write8      = function(a, v) { Module.HEAPU8[a - 0x80000000 + Module._test_mem1_host] = v & 0xFF; };
        env.ppc_write16     = function(a, v) { const o = (a - 0x80000000 + Module._test_mem1_host) | 0; Module.HEAPU16[o >> 1] = v & 0xFFFF; };
        env.ppc_write32     = function(a, v) {
            // Capture writes to PI mask MMIO so we can compare r5 to expected.
            if ((a >>> 0) === 0xCC003004) {
                if (Module._captured_pi_mask === undefined) Module._captured_pi_mask = -1;
                Module._captured_pi_mask = v | 0;
                console.log('[pi-test] stw to PI_INTERRUPT_MASK: r5=0x' + (v >>> 0).toString(16));
                return;
            }
            const o = (a - 0x80000000 + Module._test_mem1_host) | 0;
            Module.HEAPU32[o >> 2] = v | 0;
        };
        env.ppc_interp      = function(inst, pc) {};
        env.ppc_check_exc   = function(pc) { return 0; };
        env.ppc_break_block = function(pc, _) {};
        env.ppc_hle_check   = function(pc) { return 0; };
        // Declared in every emitted block's import section (even non-HLE
        // blocks); must be a callable for instantiation. Never invoked here.
        env.ppc_hle_fire    = function(pc, idx) { return 0; };
        env.ppc_stack_corrupt = function(a, b, c, d) {};  // diagnostic import; (i32x4)->void
        env.ppc_read_tb     = function(w)  { return 0; };
    });
#endif

    constexpr u32 CTX_BYTES = 0x400;
    void* ctx_raw = std::calloc(1, CTX_BYTES);
    if (!ctx_raw) { std::fprintf(stderr, "[pi-test] ctx alloc failed\n"); return 1; }
    const u32 ctx_ptr = static_cast<u32>(reinterpret_cast<uintptr_t>(ctx_raw));

    u32* guest_mem = static_cast<u32*>(std::calloc(GUEST_MEM_SIZE / 4u, 4u));
    if (!guest_mem) { std::free(ctx_raw); return 1; }

#ifdef __EMSCRIPTEN__
    const u32 mem1_host = static_cast<u32>(reinterpret_cast<uintptr_t>(guest_mem));
    EM_ASM({ Module._test_mem1_host = $0; Module._captured_pi_mask = -1; }, mem1_host);
#endif

    auto gpr = [&](u32 i) -> u32& {
        return *reinterpret_cast<u32*>(static_cast<u8*>(ctx_raw) + ppc_off::gpr(i));
    };
    auto spr = [&](u32 i) -> u32& {
        return *reinterpret_cast<u32*>(static_cast<u8*>(ctx_raw) + ppc_off::spr(i));
    };

    // Load test bytes at LOAD_PC.
    const u32 word_idx = (LOAD_PC - GUEST_MEM_BASE) / 4u;
    std::memcpy(&guest_mem[word_idx], PI_MASK_PATH, sizeof(PI_MASK_PATH));

    // Initial register state — replicates SAB iter #7 entry to 0x800e7bbc.
    gpr(3) = 0x7fe0u;        // (carries through but only matters for the rlwinm at the end)
    gpr(4) = 0xffffffe0u;    // OS interrupt mask — the cntlzw=17 path's bit-decode source
    gpr(5) = 0xDEADBEEFu;    // poison so we can see if it's overwritten
    spr(8) = SENTINEL_LR;    // lr = sentinel; blr lands here, dispatcher exits

    bemental::powerpc::g_disable_b11 = false;  // B11 ON — verifies fix

    BlockCache cache;

    // Per-block stash so we can dump trace at end via the same EM_ASM that
    // works for the final summary (per-iter EM_ASM under -pthread doesn't
    // reach the captured console reliably).
    u32 block_pcs[20]      = {0};
    u32 block_next_pcs[20] = {0};
    u32 block_r5_pre[20]   = {0};
    u32 block_r5_post[20]  = {0};

    // Compile + dispatch each block until lr-sentinel.
    u32 pc = LOAD_PC;
    int blocks_dispatched = 0;
    for (int safety = 0; safety < 1024; ++safety) {
        if (pc == SENTINEL_LR) break;
        if (cache.lookup(pc) < 0) {
            u32 insts[64];
            const u32 count = decode_block(guest_mem, pc, insts, 64);
            if (count == 0) {
                std::fprintf(stderr, "[pi-test] decode_block returned 0 at pc=0x%08x\n", pc);
                std::free(ctx_raw); std::free(guest_mem); return 1;
            }
            std::vector<u32> instr_pcs(count);
            for (u32 i = 0; i < count; ++i) instr_pcs[i] = pc + i * 4u;
            const u32 host_mem1_base = static_cast<u32>(reinterpret_cast<uintptr_t>(guest_mem));
            std::vector<u8> bytes = build_block(
                pc, insts, count, ctx_ptr,
                /*mem_pages=*/0,
                /*mem1_base=*/host_mem1_base,
                /*mem1_mask=*/GUEST_MEM_SIZE - 1u,
                /*ram_size=*/GUEST_MEM_SIZE,
                instr_pcs.data());
            // Hex-dump the final block (the one containing the stw at original
            // 0x800e7c68 = LOAD_PC + 0xAC). Compare emit between B11 on/off.
            if (pc == LOAD_PC + 0xA4u) {
                char hex[2048] = {0};
                size_t off = 0;
                for (size_t i = 0; i < bytes.size() && off < sizeof(hex) - 4; ++i) {
                    off += std::snprintf(hex + off, sizeof(hex) - off, "%02x ", bytes[i]);
                }
                std::snprintf(hex + off, sizeof(hex) - off, "");
                std::printf("[pi-test wasm-final] pc=0x%x size=%zu  %s\n", pc, bytes.size(), hex);
#ifdef __EMSCRIPTEN__
                {
                    char hdr[256];
                    std::snprintf(hdr, sizeof(hdr), "[pi-test wasm-final] pc=0x%x size=%zu  bytes follow:", pc, bytes.size());
                    EM_ASM({ console.log(UTF8ToString($0)); }, hdr);
                    EM_ASM({ console.log(UTF8ToString($0)); }, hex);
                }
#endif
            }
            if (cache.compile(pc, bytes.data(), bytes.size()) < 0) {
                std::fprintf(stderr, "[pi-test] compile failed at pc=0x%08x\n", pc);
                std::free(ctx_raw); std::free(guest_mem); return 1;
            }
        }
        s32 next_pc = 0;
        const u32 r5_pre = gpr(5);
        if (!cache.dispatch(pc, &next_pc)) {
            std::fprintf(stderr, "[pi-test] dispatch failed at pc=0x%08x\n", pc);
            std::free(ctx_raw); std::free(guest_mem); return 1;
        }
        const u32 r5_post = gpr(5);
        // Stash so we can dump all at once at end (per-iter EM_ASM/printf
        // not reaching captured console under -pthread).
        if (blocks_dispatched < 20) {
            block_pcs[blocks_dispatched]      = pc;
            block_next_pcs[blocks_dispatched] = (u32)next_pc;
            block_r5_pre[blocks_dispatched]   = r5_pre;
            block_r5_post[blocks_dispatched]  = r5_post;
        }
        pc = static_cast<u32>(next_pc);
        ++blocks_dispatched;
    }

    const u32 final_r5 = gpr(5);
    const u32 expected_r5 = 0x77FFu;
#ifdef __EMSCRIPTEN__
    int captured = -1;
    captured = EM_ASM_INT({ return (Module._captured_pi_mask | 0); });
#else
    int captured = -1;
#endif

    char buf[256];
    // Dump per-block trace at the end (EM_ASM works here; not in the loop).
    for (int i = 0; i < blocks_dispatched && i < 20; ++i) {
        std::snprintf(buf, sizeof(buf),
            "[pi-test trace] block#%d pc=0x%08x next=0x%08x r5_pre=0x%08x r5_post=0x%08x",
            i, block_pcs[i], block_next_pcs[i], block_r5_pre[i], block_r5_post[i]);
        std::printf("%s\n", buf);
#ifdef __EMSCRIPTEN__
        EM_ASM({ console.log(UTF8ToString($0)); }, buf);
#endif
    }
    // Show specifically: r5 after BLOCK 0 (the addi block). If B11 flush
    // fired, this should be 240 (0xf0). If it's still poison or 0, flush
    // didn't actually persist memory[ctx + gpr_off(5)].
    // Compact one-liner with all block PCs and r5 transitions.
    std::snprintf(buf, sizeof(buf),
        "[pi-test] blocks=%d captured=0x%08x final=0x%08x  pcs=[%x,%x,%x,%x,%x,%x,%x,%x,%x,%x,%x] r5post=[%x,%x,%x,%x,%x,%x,%x,%x,%x,%x,%x]",
        blocks_dispatched, (u32)captured, final_r5,
        block_pcs[0], block_pcs[1], block_pcs[2], block_pcs[3], block_pcs[4],
        block_pcs[5], block_pcs[6], block_pcs[7], block_pcs[8], block_pcs[9], block_pcs[10],
        block_r5_post[0], block_r5_post[1], block_r5_post[2], block_r5_post[3], block_r5_post[4],
        block_r5_post[5], block_r5_post[6], block_r5_post[7], block_r5_post[8], block_r5_post[9], block_r5_post[10]);
    std::printf("%s\n", buf);
#ifdef __EMSCRIPTEN__
    EM_ASM({ console.log(UTF8ToString($0)); }, buf);
#endif

    std::free(ctx_raw);
    std::free(guest_mem);
    bem_test_total(final_r5 == expected_r5 ? 1 : 0, final_r5 == expected_r5 ? 0 : 1);
    return (final_r5 == expected_r5) ? 0 : 1;
}
