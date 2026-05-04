// test_diff.cpp — differential testing of bementalJIT vs Dolphin's interpreter
// using DolphinPPCTests' pre-recorded oracle.
//
// For each of ~1800 oracle test cases:
//   1. Initialize a fresh PowerPCState in linear memory
//   2. Set gpr[4] = in_a, gpr[5] = in_b, XER=0, CR=0 (matches OPTEST harness)
//   3. build_block + compile + dispatch a single-instruction block
//   4. Extract gpr[3], reconstruct mfxer/mfcr equivalents from PPCState
//   5. Compare to expected exp_rd / exp_xer / exp_cr from the oracle
//
// Mismatch = bementalJIT diverges from Dolphin's interpreter (which itself
// is validated against real Wii hardware via DolphinPPCTests). Either an
// emit bug, or a missing native emitter (the test interp stub is no-op,
// so any fallback path will fail the result check).
//
// Reports: per-mnemonic pass/fail breakdown + first-N divergent cases.

#include "bementalJIT/bemental.h"
#include "guests/powerpc/gekko_emit.h"
#include "oracle_data.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

using namespace bemental;
using namespace bemental::powerpc;

// Reconstruct mfcr-equivalent u32 from Dolphin's per-field cr storage.
// Mirrors ConditionRegister::GetField exactly:
//   LT ⇔ bit 62 of u64 (= bit 30 of high u32)
//   SO ⇔ bit 59 of u64 (= bit 27 of high u32)
//   EQ ⇔ low 32 == 0
//   GT ⇔ (s64)cr_val > 0   ← can't be derived from LT/EQ alone — Dolphin
//                            relies on bit 63 being set whenever GT is
//                            false. PPCToInternal sets bit 63 = !GT.
static u32 dolphin_to_mfcr(const void* ctx_raw) {
    const u8* base = (const u8*)ctx_raw;
    u32 mfcr = 0;
    for (int i = 0; i < 8; ++i) {
        const u64 field = *(const u64*)(base + ppc_off::cr_field(i));
        const u32 high = (u32)(field >> 32);
        const u32 low  = (u32)field;
        const u32 lt = (high & (1u << 30)) ? 1u : 0u;
        const u32 eq = (low == 0u) ? 1u : 0u;
        const u32 gt = ((s64)field > 0) ? 1u : 0u;
        const u32 so = (high & (1u << 27)) ? 1u : 0u;
        const u32 nibble = (lt << 3) | (gt << 2) | (eq << 1) | so;
        mfcr |= nibble << (4 * (7 - i));
    }
    return mfcr;
}

// Reconstruct mfxer-equivalent from Dolphin's split storage:
//   xer_ca       at offset XER_CA      (u8)  — value at bit 29
//   xer_so_ov    at offset XER_SO_OV   (u8)  — format (SO<<1)|OV at bits 30-31
static u32 dolphin_to_mfxer(const void* ctx_raw) {
    const u8* base = (const u8*)ctx_raw;
    const u8 ca    = *(base + ppc_off::XER_CA);
    const u8 so_ov = *(base + ppc_off::XER_SO_OV);
    return ((u32)ca << 29) | ((u32)so_ov << 30);
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
        env.ppc_hle_check   = function(pc) { return 0; };
    });
#endif

    constexpr u32 CTX_BYTES = 0x400;
    constexpr u32 START_PC = 0x80003000;

    BlockCache cache;
    void* ctx_raw = std::calloc(1, CTX_BYTES);
    if (!ctx_raw) { std::printf("[FAIL] calloc\n"); return 1; }
    const u32 ctx_ptr = (u32)(uintptr_t)ctx_raw;

    std::map<std::string, std::pair<unsigned, unsigned>> per_mnemonic;  // pass / fail
    unsigned total_pass = 0, total_fail = 0;
    std::vector<std::string> first_failures;

    for (unsigned i = 0; i < k_oracle_case_count; ++i) {
        const OracleCase& tc = k_oracle_cases[i];

        // Reset state. Each test starts with the macro's SetCR(0)/SetXER(0).
        std::memset(ctx_raw, 0, CTX_BYTES);
        u8* base = (u8*)ctx_raw;
        *(u32*)(base + ppc_off::gpr(4)) = tc.in_a;
        *(u32*)(base + ppc_off::gpr(5)) = tc.in_b;
        // Initialize CR fields to PPCToInternal(0) — Dolphin's "all-flags-
        // clear" canonical form. A memset-zero state would read as "EQ
        // set" via GetField (low 32 == 0), which is NOT what real PPC
        // means by an unwritten CR field.
        for (int f = 0; f < 8; ++f) {
            *(u64*)(base + ppc_off::cr_field(f)) = 0x8000000100000001ULL;
        }

        // Build a 1-instruction block. instr_pcs sequential.
        u32 instr_pcs[1] = {START_PC};
        std::vector<u8> bytes = build_block(START_PC, &tc.instr_word, 1, ctx_ptr,
                                            /*mem_pages=*/0, /*mem1_base=*/0,
                                            /*mem1_mask=*/0, /*ram_size=*/0,
                                            instr_pcs);

        // Each iteration uses a fresh start_pc-keyed entry. Cache.compile()
        // releases the prior entry if the key collides — but to be safe we
        // give each test its own pc by offsetting.
        const u32 pc_for_this = START_PC + (i & 0xFFFu) * 0x100u;
        // Re-emit with the correct pc baked in (set_pc constants depend on pc).
        instr_pcs[0] = pc_for_this;
        bytes = build_block(pc_for_this, &tc.instr_word, 1, ctx_ptr,
                            0, 0, 0, 0, instr_pcs);

        int handle = cache.compile(pc_for_this, bytes.data(), bytes.size());
        if (handle < 0) { ++total_fail; per_mnemonic[tc.name].second++; continue; }

        s32 next_pc = -1;
        if (!cache.dispatch(pc_for_this, &next_pc)) {
            ++total_fail; per_mnemonic[tc.name].second++; continue;
        }

        const u32 got_rd  = *(u32*)(base + ppc_off::gpr(3));
        const u32 got_xer = dolphin_to_mfxer(ctx_raw);
        const u32 got_cr  = dolphin_to_mfcr(ctx_raw);

        const bool ok = (got_rd  == tc.exp_rd)
                     && (got_xer == tc.exp_xer)
                     && (got_cr  == tc.exp_cr);
        if (ok) {
            ++total_pass;
            per_mnemonic[tc.name].first++;
        } else {
            ++total_fail;
            per_mnemonic[tc.name].second++;
            if (first_failures.size() < 20) {
                char buf[256];
                std::snprintf(buf, sizeof(buf),
                    "%-8s  in_a=0x%08x in_b=0x%08x  rd %s%08x exp%08x  xer %s%08x exp%08x  cr %s%08x exp%08x",
                    tc.name, tc.in_a, tc.in_b,
                    (got_rd == tc.exp_rd ? "==" : "!="),  got_rd,  tc.exp_rd,
                    (got_xer == tc.exp_xer ? "==" : "!="), got_xer, tc.exp_xer,
                    (got_cr == tc.exp_cr ? "==" : "!="),  got_cr,  tc.exp_cr);
                first_failures.emplace_back(buf);
            }
        }
    }

    std::free(ctx_raw);

    // Per-mnemonic summary.
    char buf[256];
    std::printf("\n=== per-mnemonic ===\n");
    for (const auto& kv : per_mnemonic) {
        std::snprintf(buf, sizeof(buf), "%-8s  pass=%4u  fail=%4u",
                      kv.first.c_str(), kv.second.first, kv.second.second);
        report(buf, kv.second.second == 0u);
    }

    if (!first_failures.empty()) {
        std::printf("\n=== first %zu divergences ===\n", first_failures.size());
        for (const auto& s : first_failures) std::printf("  %s\n", s.c_str());
    }

    std::snprintf(buf, sizeof(buf), "TOTAL: %u passed, %u failed (of %u)",
                  total_pass, total_fail, k_oracle_case_count);
    report(buf, total_fail == 0u);
    return total_fail == 0 ? 0 : 1;
}
