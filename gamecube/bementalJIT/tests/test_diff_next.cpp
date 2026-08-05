// test_diff_next.cpp — differential testing of the LIVE powerpc-next emitter
// (build_block_next, the production path per JitWasm.cpp:291) against
// DolphinPPCTests' console-recorded oracle. Port of test_diff.cpp, which
// exercises only the legacy guests/powerpc emitter.
//
// Covers the same six OPTEST shapes (3op / 2op / imm / cmp / cmp-imm / 5op).
//
// Classification per case:
//   PASS     — natively emitted, post-state matches oracle
//   FAIL     — natively emitted, post-state diverges (a real emitter bug)
//   FALLBACK — op routed to WIMPORT_INTERP; the stub here is a no-op so
//              semantics can't be validated in this harness. In production
//              the fallback IS Dolphin's interpreter, so these are
//              conformant-by-construction; they are counted separately and
//              do not pass or fail.

#include "bementalJIT/bemental.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"
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
// Mirrors ConditionRegister::GetField exactly. (Same as test_diff.cpp;
// powerpc-next ppc_offsets.h values are byte-identical to legacy ppc_off.)
extern "C" void bem_materialize_pending_cr(void* ctx_base);  // [PM56 lazy-CR]

static u32 dolphin_to_mfcr(const void* ctx_raw) {
    const u8* base = (const u8*)ctx_raw;
    u32 mfcr = 0;
    for (int i = 0; i < 8; ++i) {
        const u64 field = *(const u64*)(base + ppc_off::cr(i));
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

static u32 dolphin_to_mfxer(const void* ctx_raw) {
    const u8* base = (const u8*)ctx_raw;
    const u8 ca    = *(base + ppc_off::XER_CA);
    const u8 so_ov = *(base + ppc_off::XER_SO_OV);
    return ((u32)ca << 29) | ((u32)so_ov << 30);
}

// ---------------------------------------------------------------------------
// PEM reference models for rlwinm/rlwimi/srawi.
//
// WHY: DolphinPPCTests' OPTEST_5_COMPONENTS (Integer.cpp:73-81) and the srawi
// driver pass SH/MB/ME into inline asm with "r" (register) constraints, but
// those are IMMEDIATE fields in the encodings — the assembled instruction's
// immediates are the REGISTER NUMBERS gcc allocated, not the logical values
// printed. Verified against instruction_tests_console.txt:1144 (rD=0xE0000001
// for printed rS=0x1E,SH=0,MB=0,ME=10 whose architectural result is 0 — but
// exactly rotl(0x1E,28)&wrap-mask) and the SRAWI block (rD=1 for
// 0x7FFFFFFF with printed shifts 4/5/6 — only correct for shift 30, constant
// across rows). parse_oracle.py encodes from the PRINTED values, so for these
// families exp_* describes an instruction that never executed on console.
// Expectations below are therefore computed from the decoded instr_word via
// the PEM reference, with mask/carry models lifted verbatim from
// ~/gc_refs/hwtests/cputest/rlw.cpp (GetHelperMask) and srawix.cpp (GetCarry).
// ---------------------------------------------------------------------------
static u32 ref_mask(int mb, int me) {
    const u32 begin = 0xFFFFFFFFu >> mb;
    const u32 end = me < 31 ? (0xFFFFFFFFu >> (me + 1)) : 0;
    const u32 mask = begin ^ end;
    return (me < mb) ? ~mask : mask;
}
static u32 ref_rotl(u32 v, u32 n) {
    n &= 31;
    return n == 0 ? v : ((v << n) | (v >> (32 - n)));
}
static int ref_srawi_carry(s32 value, int shift) {
    if (shift == 0) return 0;
    return (value < 0) && (((value >> shift) << shift) != value);
}
static u32 ref_cr0(u32 rd) {
    const u32 lt = ((s32)rd < 0) ? 1u : 0u;
    const u32 gt = ((s32)rd > 0) ? 1u : 0u;
    const u32 eq = (rd == 0) ? 1u : 0u;
    return ((lt << 3) | (gt << 2) | (eq << 1) | 0u) << 28;  // SO=0 (XER cleared)
}
// Returns true and fills exp_* if this case belongs to an oracle-artifact
// family. r3_init = the value pre-loaded into the destination register
// (read-modify-write input for rlwimi).
static bool pem_expected(const OracleCase& tc, u32 r3_init,
                         u32* exp_rd, u32* exp_xer, u32* exp_cr) {
    const u32 inst = tc.instr_word;
    const u32 primary = inst >> 26;
    const u32 xo10 = (inst >> 1) & 0x3FF;
    const bool rc = (inst & 1u) != 0;
    const u32 sh = (inst >> 11) & 0x1F;
    const u32 mb = (inst >> 6) & 0x1F;
    const u32 me = (inst >> 1) & 0x1F;
    const u32 rs = tc.in_a;  // harness drives rS via r4 = in_a

    if (primary == 21) {            // rlwinm
        *exp_rd = ref_rotl(rs, sh) & ref_mask((int)mb, (int)me);
    } else if (primary == 20) {     // rlwimi
        const u32 m = ref_mask((int)mb, (int)me);
        *exp_rd = (ref_rotl(rs, sh) & m) | (r3_init & ~m);
    } else if (primary == 31 && xo10 == 824) {  // srawi
        *exp_rd = (u32)((s32)rs >> sh);
        *exp_xer = (u32)ref_srawi_carry((s32)rs, (int)sh) << 29;
        *exp_cr = rc ? ref_cr0(*exp_rd) : 0u;
        return true;
    } else {
        return false;
    }
    *exp_xer = 0u;                  // rlwinm/rlwimi do not touch XER
    *exp_cr = rc ? ref_cr0(*exp_rd) : 0u;
    return true;
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

// Drain the interp-call counter maintained by the env.ppc_interp stub.
// Returns how many times the fallback fired since the last drain.
static int drain_interp_calls() {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        const n = Module.__interp_calls | 0;
        Module.__interp_calls = 0;
        return n;
    });
#else
    return 0;
#endif
}

// [accurate-nans-gate PM59] The conformance differential validates the ACCURATE
// paired-single NaN path bit-for-bit vs DolphinPPCTests, so force it on here
// (runtime/games default it off to match native Jit64's m_accurate_nans=false).
extern "C" uint32_t g_bem_accurate_nans;
extern "C" uint32_t g_bem_ni_flush;

int main() {
    g_bem_accurate_nans = 1u;   // validate the accurate ladder path
    g_bem_ni_flush      = 1u;   // validate the NI/FTZ subnormal-flush path
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        Module.__interp_calls = 0;
        env.ppc_read8        = function(addr) { return 0; };
        env.ppc_read16       = function(addr) { return 0; };
        env.ppc_read32       = function(addr) { return 0; };
        env.ppc_write8       = function(addr, val) {};
        env.ppc_write16      = function(addr, val) {};
        env.ppc_write32      = function(addr, val) {};
        env.ppc_interp       = function(inst, pc) { Module.__interp_calls++; };
        env.ppc_check_exc    = function(pc) { return 0; };
        env.ppc_break_block  = function(pc, _) {};
        env.ppc_hle_check    = function(pc) { return 0; };
        env.ppc_hle_fire     = function(pc, idx) { return 0; };
        env.ppc_msr_updated  = function(msr) {};
        env.ppc_gather_drain = function() {};
    });
#endif

    // SPR_BASE=0x340 + 1024 SPRs * 4 — size the context so a stray
    // mtspr/mfspr in an emitted block can't scribble past the allocation.
    constexpr u32 CTX_BYTES = 0x1400;
    constexpr u32 START_PC = 0x80003000;

    BlockCache cache;
    void* ctx_raw = std::calloc(1, CTX_BYTES);
    if (!ctx_raw) { std::printf("[FAIL] calloc\n"); return 1; }
    const u32 ctx_ptr = (u32)(uintptr_t)ctx_raw;

    // name -> {pass, fail, fallback}
    struct Tally { unsigned pass = 0, fail = 0, fallback = 0; };
    std::map<std::string, Tally> per_mnemonic;
    unsigned total_pass = 0, total_fail = 0, total_fallback = 0,
             total_compile_fail = 0, total_pem = 0;
    std::vector<std::string> first_failures;

    for (unsigned i = 0; i < k_oracle_case_count; ++i) {
        const OracleCase& tc = k_oracle_cases[i];

        // Reset state. Each OPTEST clears CR/XER before running.
        std::memset(ctx_raw, 0, CTX_BYTES);
        u8* base = (u8*)ctx_raw;

        // CR fields to PPCToInternal(0) — Dolphin's "all-flags-clear"
        // canonical form. Memset-zero would read as "EQ set."
        for (int f = 0; f < 8; ++f) {
            *(u64*)(base + ppc_off::cr(f)) = 0x8000000100000001ULL;
        }

        // r4 = in_a (always), r5 = in_b (3OP/CMP shapes).
        *(u32*)(base + ppc_off::gpr(4)) = tc.in_a;
        *(u32*)(base + ppc_off::gpr(5)) = tc.in_b;
        // RLWIMI reads its destination before writing (mask-insert). Drive a
        // fixed distinctive pattern as the RMW input; the PEM reference below
        // computes the expectation from the same value.
        u32 r3_init = 0;
        if ((tc.instr_word >> 26) == 20) {  // rlwimi
            r3_init = 0xA5A5C3C3u;
            *(u32*)(base + ppc_off::gpr(3)) = r3_init;
        }

        const u32 pc_for_this = START_PC + (i & 0xFFFu) * 0x100u;
        std::vector<u8> bytes = build_block_next(pc_for_this, &tc.instr_word, 1,
                                                 ctx_ptr, 0, 0, 0);

        int handle = cache.compile(pc_for_this, bytes.data(), bytes.size());
        if (handle < 0) {
            ++total_compile_fail; ++total_fail;
            per_mnemonic[tc.name].fail++;
            continue;
        }

        drain_interp_calls();
        s32 next_pc = -1;
        if (!cache.dispatch(pc_for_this, &next_pc)) {
            ++total_fail; per_mnemonic[tc.name].fail++; continue;
        }
        const int interp_calls = drain_interp_calls();

        if (interp_calls > 0) {
            // Fallback-routed: production sends this to Dolphin's
            // interpreter; nothing to diff against a no-op stub.
            ++total_fallback;
            per_mnemonic[tc.name].fallback++;
            continue;
        }

        // [PM56 lazy-CR] a raw cr[] read is a materialization boundary (like
        // mfcr/savestate in the real system): settle deferred fields first, so
        // the differential validates the deferred->eager reconstruction against
        // the oracle's eager cr.
        bem_materialize_pending_cr(ctx_raw);
        const u32 got_rd  = *(u32*)(base + ppc_off::gpr(3));
        const u32 got_xer = dolphin_to_mfxer(ctx_raw);
        const u32 got_cr  = dolphin_to_mfcr(ctx_raw);

        // For the oracle-artifact families, expectations come from the PEM
        // reference (see header above); everything else uses the console
        // recording as-is.
        u32 exp_rd = tc.exp_rd, exp_xer = tc.exp_xer, exp_cr = tc.exp_cr;
        if (pem_expected(tc, r3_init, &exp_rd, &exp_xer, &exp_cr)) ++total_pem;

        const bool check_rd = (tc.shape != OS_CMP) && (tc.shape != OS_CMP_IMM);
        const bool ok = (!check_rd || got_rd == exp_rd)
                     && (got_xer == exp_xer)
                     && (got_cr  == exp_cr);
        if (ok) {
            ++total_pass;
            per_mnemonic[tc.name].pass++;
        } else {
            ++total_fail;
            per_mnemonic[tc.name].fail++;
            if (first_failures.size() < 600) {
                char buf[256];
                std::snprintf(buf, sizeof(buf),
                    "%-8s shape=%u inst=%08x in_a=0x%08x in_b=0x%08x  rd %s%08x exp%08x  xer %s%08x exp%08x  cr %s%08x exp%08x",
                    tc.name, tc.shape, tc.instr_word, tc.in_a, tc.in_b,
                    (got_rd == exp_rd ? "==" : "!="),  got_rd,  exp_rd,
                    (got_xer == exp_xer ? "==" : "!="), got_xer, exp_xer,
                    (got_cr == exp_cr ? "==" : "!="),  got_cr,  exp_cr);
                first_failures.emplace_back(buf);
            }
        }
    }

    std::free(ctx_raw);

    char buf[256];
    std::printf("\n=== per-mnemonic (live powerpc-next emitter) ===\n");
    for (const auto& kv : per_mnemonic) {
        std::snprintf(buf, sizeof(buf), "%-8s  pass=%4u  fail=%4u  fallback=%4u",
                      kv.first.c_str(), kv.second.pass, kv.second.fail,
                      kv.second.fallback);
        report(buf, kv.second.fail == 0u);
    }

    if (!first_failures.empty()) {
        std::printf("\n=== first %zu divergences ===\n", first_failures.size());
        for (const auto& s : first_failures) std::printf("  %s\n", s.c_str());
    }

    std::snprintf(buf, sizeof(buf),
                  "TOTAL: %u passed, %u failed, %u interp-fallback (of %u; %u compile-fail; %u PEM-referenced)",
                  total_pass, total_fail, total_fallback,
                  k_oracle_case_count, total_compile_fail, total_pem);
    report(buf, total_fail == 0u);
    return total_fail == 0 ? 0 : 1;
}
