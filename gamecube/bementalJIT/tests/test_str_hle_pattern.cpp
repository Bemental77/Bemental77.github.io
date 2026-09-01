// test_str_hle_pattern.cpp — validates that the SAB strcat byte sequence
// at 0x8010df88..0x8010dfb0 produces correct output when JIT-dispatched.
//
// This is the OPPOSITE direction from test_pi_mask_path: we don't trigger
// the HLE replacement here (no PatchFunctions registry inside the test).
// Instead we run the raw PPC-decoded body through bementalJIT and check the
// guest memory after dispatch matches the libc strcat semantics. If the
// raw JIT path works, then an HLE replacement that produces the same
// observable effect (memory content + r3 preserved) is functionally
// equivalent.
//
// Anticipates: any change to bementalJIT lbzu/stbu/cmpli/bne emit that
// would silently break strcat-shaped loops. If this test fails, the SAB
// HLEStrcat patch is masking a JIT bug — without HLE replacement enabled,
// we'd see strcat produce wrong output and game data would corrupt.

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

// Exact bytes from SAB DOL 0x8010df88..0x8010dfb0 (strcat).
static const u32 STRCAT_BYTES[] = {
    0x3884ffff,  // 0x00: addi r4, r4, -1     ; r4 = src - 1
    0x38a3ffff,  // 0x04: addi r5, r3, -1     ; r5 = dst - 1
    0x8c050001,  // 0x08: lbzu r0, 1(r5)      ; loop1: walk dst to null
    0x28000000,  // 0x0c: cmpli cr0, r0, 0
    0x4082fff8,  // 0x10: bne 0x08
    0x38a5ffff,  // 0x14: addi r5, r5, -1     ; back up r5 (to char before null)
    0x8c040001,  // 0x18: lbzu r0, 1(r4)      ; loop2: copy src bytes
    0x28000000,  // 0x1c: cmpli cr0, r0, 0
    0x9c050001,  // 0x20: stbu r0, 1(r5)
    0x4082fff4,  // 0x24: bne 0x18
    0x4e800020,  // 0x28: blr
};
static constexpr u32 STRCAT_LEN = sizeof(STRCAT_BYTES) / sizeof(STRCAT_BYTES[0]);

static constexpr u32 GUEST_MEM_BASE = 0x80000000u;
static constexpr u32 GUEST_MEM_SIZE = 0x00400000u;
static constexpr u32 LOAD_PC        = 0x80003000u;
static constexpr u32 SENTINEL_LR    = 0xDEADBEEFu;
static constexpr u32 DST_VADDR      = 0x80100000u;
static constexpr u32 SRC_VADDR      = 0x80200000u;

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

int main() {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        env.ppc_read8       = function(a)    { return (Module.HEAPU8[a - 0x80000000 + Module._test_mem1_host] | 0); };
        env.ppc_read16      = function(a)    { const o = (a - 0x80000000 + Module._test_mem1_host) | 0; return (Module.HEAPU16[o >> 1] | 0); };
        env.ppc_read32      = function(a)    { const o = (a - 0x80000000 + Module._test_mem1_host) | 0; return (Module.HEAPU32[o >> 2] | 0); };
        env.ppc_write8      = function(a, v) { Module.HEAPU8[a - 0x80000000 + Module._test_mem1_host] = v & 0xFF; };
        env.ppc_write16     = function(a, v) { const o = (a - 0x80000000 + Module._test_mem1_host) | 0; Module.HEAPU16[o >> 1] = v & 0xFFFF; };
        env.ppc_write32     = function(a, v) { const o = (a - 0x80000000 + Module._test_mem1_host) | 0; Module.HEAPU32[o >> 2] = v | 0; };
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
    if (!ctx_raw) return 1;
    const u32 ctx_ptr = static_cast<u32>(reinterpret_cast<uintptr_t>(ctx_raw));

    u32* guest_mem = static_cast<u32*>(std::calloc(GUEST_MEM_SIZE / 4u, 4u));
    if (!guest_mem) { std::free(ctx_raw); return 1; }

#ifdef __EMSCRIPTEN__
    const u32 mem1_host = static_cast<u32>(reinterpret_cast<uintptr_t>(guest_mem));
    EM_ASM({ Module._test_mem1_host = $0; }, mem1_host);
#endif

    auto gpr = [&](u32 i) -> u32& {
        return *reinterpret_cast<u32*>(static_cast<u8*>(ctx_raw) + ppc_off::gpr(i));
    };
    auto spr = [&](u32 i) -> u32& {
        return *reinterpret_cast<u32*>(static_cast<u8*>(ctx_raw) + ppc_off::spr(i));
    };

    // Load strcat at LOAD_PC.
    const u32 word_idx = (LOAD_PC - GUEST_MEM_BASE) / 4u;
    std::memcpy(&guest_mem[word_idx], STRCAT_BYTES, sizeof(STRCAT_BYTES));

    // Set up dst and src strings in guest memory.
    auto guest_byte = [&](u32 va) -> u8& {
        return reinterpret_cast<u8*>(guest_mem)[va - GUEST_MEM_BASE];
    };
    const char* dst_init = "Hello, ";
    const char* src_init = "world!";
    for (u32 i = 0; i <= std::strlen(dst_init); ++i) guest_byte(DST_VADDR + i) = (u8)dst_init[i];
    for (u32 i = 0; i <= std::strlen(src_init); ++i) guest_byte(SRC_VADDR + i) = (u8)src_init[i];

    gpr(3) = DST_VADDR;
    gpr(4) = SRC_VADDR;
    spr(8) = SENTINEL_LR;

    bemental::powerpc::g_disable_b11 = false;
    BlockCache cache;

    u32 pc = LOAD_PC;
    int blocks_dispatched = 0;
    for (int safety = 0; safety < 1024; ++safety) {
        if (pc == SENTINEL_LR) break;
        if (cache.lookup(pc) < 0) {
            u32 insts[64];
            const u32 count = decode_block(guest_mem, pc, insts, 64);
            if (count == 0) { std::free(ctx_raw); std::free(guest_mem); return 1; }
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
            if (cache.compile(pc, bytes.data(), bytes.size()) < 0) {
                std::free(ctx_raw); std::free(guest_mem); return 1;
            }
        }
        s32 next_pc = 0;
        if (!cache.dispatch(pc, &next_pc)) {
            std::free(ctx_raw); std::free(guest_mem); return 1;
        }
        pc = static_cast<u32>(next_pc);
        ++blocks_dispatched;
    }

    // Read result from guest memory.
    char result[64] = {0};
    for (u32 i = 0; i < sizeof(result) - 1; ++i) {
        const u8 c = guest_byte(DST_VADDR + i);
        if (c == 0) { result[i] = 0; break; }
        result[i] = static_cast<char>(c);
    }
    const char* expected = "Hello, world!";
    const bool ok_str = std::strcmp(result, expected) == 0;
    const bool ok_r3  = (gpr(3) == DST_VADDR);

    char buf[256];
    std::snprintf(buf, sizeof(buf),
        "[strcat-test] blocks=%d result=\"%s\" r3=0x%08x  expected=\"%s\" expected_r3=0x%08x  %s",
        blocks_dispatched, result, gpr(3), expected, DST_VADDR,
        (ok_str && ok_r3) ? "PASS" : "FAIL");
    std::printf("%s\n", buf);
#ifdef __EMSCRIPTEN__
    EM_ASM({ console.log(UTF8ToString($0)); }, buf);
#endif

    std::free(ctx_raw);
    std::free(guest_mem);
    return (ok_str && ok_r3) ? 0 : 1;
}
