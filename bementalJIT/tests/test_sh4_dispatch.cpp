// test_sh4_dispatch.cpp — minimal seam smoke test for the SH4 emitter.
//
// RuntimeBlockInfo carries enough Flycast dependencies that constructing one
// host-side would drag in blockmanager.cpp and friends. The current seam
// supports a null-block path that produces a valid empty WASM module — that
// is what this test exercises. Once a stand-alone test fixture for
// RuntimeBlockInfo lands (or the Flycast deps get sliced), expand this to
// cover BET_CLS_Static / Dynamic / COND emitBlockExit branches.

#include "wasm_emit.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

// --- Mocked flycast deps the SH4 emitter references at link time. Their
//     values do NOT affect the VRAM-swizzle constants this test scans for;
//     they only need to resolve so the emitter links host-side. ---
#include "hw/sh4/sh4_mem.h"
u32 getRegOffset(Sh4RegType reg) { return 0xC0u + (u32)(reg - reg_r0) * 4u; } // r[N] @ 0xC0+N*4
bool rdv_writeMemImmediate(u32, int, void*& ptr, bool& isRam, u32&, RuntimeBlockInfo*) {
    ptr = nullptr; isRam = false; return false;  // bail -> emit register/VRAM runtime path
}
bool rdv_readMemImmediate(u32, int, void*& ptr, bool& isRam, u32&, RuntimeBlockInfo*) {
    ptr = nullptr; isRam = false; return false;
}
void fatal_error(const char*, ...) {}
void os_DebugBreak() {}
static u16 DYNACALL stub_read16(u32) { return 0; }
ReadMem16Func ReadMem16 = stub_read16;

// --- Reference: flycast pvr_map32 (pvr_mem.cpp:289), the area-1/32-bit VRAM
//     bank-interleave that maps a guest VRAM offset to vram[]. VRAM_MASK=0x7FFFFF,
//     VRAM_BANK_BIT=0x400000. ---
static u32 pvr_map32_ref(u32 o) {
    // Dreamcast VRAM = 8 MB. Note flycast's VRAM_MASK is a macro
    // (settings.platform.vram_mask) — use the DC constant directly here.
    const u32 kVramMask = 0x7FFFFF, kVramBank = 0x400000;
    u32 static_bits = kVramMask - (kVramBank * 2 - 1) + 3;
    u32 offset_bits = (kVramBank - 1) & ~3u;
    u32 bank = (o & kVramBank) / kVramBank;
    u32 rv = o & static_bits;
    rv |= (o & offset_bits) * 2;
    rv |= bank * 4;
    return rv;
}

// The swizzle the SH4 emitter bakes for the area-1 32-bit VRAM writem fastpath
// (wasm_emit.cpp). Must equal pvr_map32_ref for every offset.
static u32 emitted_vram_swizzle(u32 m) {
    return (m & 3) | ((m & 0x3FFFFC) << 1) | ((m & 0x400000) >> 20);
}

static bool bytes_contain(const std::vector<u8>& hay, std::initializer_list<u8> pat) {
    if (pat.size() == 0 || hay.size() < pat.size()) return false;
    for (size_t i = 0; i + pat.size() <= hay.size(); ++i) {
        size_t j = 0; for (u8 b : pat) { if (hay[i + j] != b) break; ++j; }
        if (j == pat.size()) return true;
    }
    return false;
}

static void report(const char* line, bool pass) {
    std::printf("%s %s\n", pass ? "[PASS]" : "[FAIL]", line);
#ifdef __EMSCRIPTEN__
    EM_ASM({
        const msg  = UTF8ToString($0);
        const pass = $1;
        if (typeof document === 'undefined') return;
        let pre = document.getElementById('bemental-out');
        if (!pre) {
            pre = document.createElement('pre');
            pre.id = 'bemental-out';
            pre.style.cssText = 'font: 14px ui-monospace, Menlo, monospace; padding: 16px;';
            document.body.appendChild(pre);
        }
        const tag = pass ? '[PASS] ' : '[FAIL] ';
        pre.textContent += tag + msg + '\n';
    }, line, pass ? 1 : 0);
#endif
}

int main() {
    std::vector<u8> bytes = bemental::sh4::build_block(nullptr);
    std::printf("[info] built SH4 WASM module: %zu bytes\n", bytes.size());

    bool magic_ok = bytes.size() >= 8
        && bytes[0] == 0x00 && bytes[1] == 0x61 && bytes[2] == 0x73 && bytes[3] == 0x6D
        && bytes[4] == 0x01 && bytes[5] == 0x00 && bytes[6] == 0x00 && bytes[7] == 0x00;
    report("module header is \\0asm\\1\\0\\0\\0", magic_ok);

    bool all_ok = magic_ok;

    // --- Test: emitter's baked VRAM swizzle == flycast pvr_map32 over 8 MB ---
    {
        int mism = 0;
        for (u32 m = 0; m < 0x800000u; m += 4)
            if (pvr_map32_ref(m) != emitted_vram_swizzle(m)) mism++;
        bool ok = (mism == 0);
        report("VRAM area-1 swizzle matches pvr_map32 over 8MB", ok);
        all_ok = all_ok && ok;
    }

    // --- Test: shop_writem(size=4) to an area-1 VRAM register emits the
    //     swizzled fastpath (its distinctive mask constants 0x3FFFFC / 0x400000
    //     appear as i32.const LEB128 in the module). ---
    {
        using namespace bemental::sh4;
        u32 saved = g_vram_lin_base;
        g_vram_lin_base = 0x10000;          // non-zero → VRAM fastpath emitted

        RuntimeBlockInfo blk;
        blk.vaddr       = 0x8c000000;
        blk.BlockType   = BET_StaticJump;
        blk.BranchBlock = 0x8c000002;
        blk.NextBlock   = 0x8c000002;
        blk.guest_cycles = 1;
        blk.has_jcond   = false;

        shil_opcode op{};
        op.op   = shop_writem;
        op.size = 4;
        op.rs1  = shil_param(reg_r14);      // dst address (register → runtime path)
        op.rs2  = shil_param(reg_r5);       // value
        blk.oplist.push_back(op);

        std::vector<u8> wb = build_block(&blk);
        std::printf("[info] writem block module: %zu bytes\n", wb.size());

        bool mask_3ffffc = bytes_contain(wb, {0xfc, 0xff, 0xff, 0x01}); // 0x3FFFFC
        bool mask_400000 = bytes_contain(wb, {0x80, 0x80, 0x80, 0x02}); // 0x400000
        bool ok = mask_3ffffc && mask_400000;
        report("shop_writem emits area-1 VRAM swizzle (0x3FFFFC + 0x400000)", ok);
        all_ok = all_ok && ok;

        g_vram_lin_base = saved;
    }

    return all_ok ? 0 : 1;
}
