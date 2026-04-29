// test_gekko.cpp — end-to-end smoke test for the Gekko (PowerPC) emitter.
//
// Builds a 3-instruction block:
//   addi r3, 0, 7      ; r3 = 7         (rt=3, ra=0, simm=7)
//   addi r4, 0, 35     ; r4 = 35        (rt=4, ra=0, simm=35)
//   addi r3, r3, 0     ; force a no-op so emit_addi is exercised non-trivially
//
// Then it builds a WASM module via build_block() that points at a fake
// PowerPCState in linear memory at offset 0x1000, and dispatches it.
//
// Verifies:
//   - module compiled (handle >= 0)
//   - dispatch returned the next-PC = start_pc + 12
//   - PowerPCState.gpr[3] == 7 and gpr[4] == 35 in linear memory
//
// Note: The test builds with all 9 host imports declared (ppc_read*,
// ppc_write*, ppc_interp, ppc_check_exc, ppc_break_block) but the 3-instr
// addi block doesn't actually call any of them. So we can rely on the
// dispatcher's own JS-side stubs to satisfy the import linkage.
//
// The check_value reads from JS via EM_ASM (linear memory is shared).

#include "bementalCompiler/bemental.h"
#include "guests/powerpc/gekko_emit.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

using namespace bemental;
using namespace bemental::powerpc;

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

// Encode an `addi rt, ra, simm` instruction word.
//   PowerPC addi: opcode=14, RT=21..25, RA=16..20, SIMM=0..15
static u32 enc_addi(u32 rt, u32 ra, s32 simm) {
    u32 inst = (14u << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16);
    inst |= (u32)(s32)(s16)simm & 0xFFFFu;
    return inst;
}

int main() {
    // Install JS-side stubs for the 9 PowerPC host imports the emitter
    // declares. Our test's 3-instruction addi block doesn't actually call
    // any of these, but the WASM module declares them all and instantiation
    // needs every import to resolve.
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        env.ppc_read8       = function(addr) { return 0; };
        env.ppc_read16      = function(addr) { return 0; };
        env.ppc_read32      = function(addr) { return 0; };
        env.ppc_write8      = function(addr, val) {};
        env.ppc_write16     = function(addr, val) {};
        env.ppc_write32     = function(addr, val) {};
        env.ppc_interp      = function(inst, pc) {};
        env.ppc_check_exc   = function(pc) { return 0; };
        env.ppc_break_block = function(pc, _) {};
    });
#endif

    // Allocate a fake PowerPCState in linear memory (zero-initialized).
    // Just need enough bytes to cover up to spr[8].
    constexpr u32 CTX_BYTES = 0x400;
    void* ctx_raw = std::calloc(1, CTX_BYTES);
    if (!ctx_raw) { report("calloc failed", false); return 1; }
    const u32 ctx_ptr = (u32)(uintptr_t)ctx_raw;

    // Build a 3-instruction block.
    const u32 START_PC = 0x80003000;
    const u32 instrs[3] = {
        enc_addi(3, 0, 7),       // r3 = 7
        enc_addi(4, 0, 35),      // r4 = 35
        enc_addi(3, 3, 0),       // r3 = r3 + 0 = 7 (no-op, exercises non-RA=0 path)
    };
    std::vector<u8> bytes = build_block(START_PC, instrs, 3, ctx_ptr);
    std::printf("[info] gekko block built: %zu bytes\n", bytes.size());

    BlockCache cache;
    int handle = cache.compile(START_PC, bytes.data(), bytes.size());
    if (handle < 0) {
        report("compile failed (handle < 0)", false);
        std::free(ctx_raw);
        return 1;
    }
    char buf[96];
    std::snprintf(buf, sizeof(buf), "compile ok (handle=%d)", handle);
    report(buf, true);

    s32 next_pc = -1;
    if (!cache.dispatch(START_PC, &next_pc)) {
        report("dispatch returned false", false);
        std::free(ctx_raw);
        return 1;
    }
    const s32 expected_next = (s32)(START_PC + 12u);
    std::snprintf(buf, sizeof(buf),
                  "dispatch ok: next_pc=0x%x (expected 0x%x)",
                  (u32)next_pc, (u32)expected_next);
    report(buf, next_pc == expected_next);

    // Read back gpr[3] and gpr[4] from the fake state.
    // ppc_off::GPR_BASE = 0x18, gpr[3] = +0x24, gpr[4] = +0x28.
    u32 r3 = *(u32*)((u8*)ctx_raw + ppc_off::gpr(3));
    u32 r4 = *(u32*)((u8*)ctx_raw + ppc_off::gpr(4));
    std::snprintf(buf, sizeof(buf), "gpr[3]=%u (expected 7), gpr[4]=%u (expected 35)", r3, r4);
    report(buf, r3 == 7 && r4 == 35);

    std::free(ctx_raw);
    return (next_pc == expected_next && r3 == 7 && r4 == 35) ? 0 : 1;
}
