// test_gekko.cpp — per-emitter block corpus for the Gekko (PowerPC) JIT.
//
// Each test_* function builds a small block of PowerPC instructions,
// compiles it via build_block, dispatches once, and asserts on:
//   - the next_pc returned by the dispatcher
//   - register/memory deltas in the fake PowerPCState
//
// Test categories mirror the bug classes we've hit at runtime:
//   - Branch terminators: bx (LK on/off), bcx (taken / not-taken /
//     chain_fallthrough — the bne+ regression pattern), blr indirect.
//   - Load/store fast path.
//   - Sequential ALU + edge cases (block with no terminator).
//
// Structure: each test gets its own fake PowerPCState (no cross-test
// contamination); a TestCase array drives the runner. Returns 0 if all
// tests pass.

#include "bementalJIT/bemental.h"
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

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Instruction encoding helpers (just what the corpus needs).
// All forms verified against IBM PowerPC user manual.
// ---------------------------------------------------------------------------

// addi rt, ra, simm  (op 14, RA=0 means use 0 not r0 per ISA)
static u32 enc_addi(u32 rt, u32 ra, s32 simm) {
    return (14u << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((u32)(s32)(s16)simm & 0xFFFFu);
}

// add rt, ra, rb  (op 31, sub-op 266)
static u32 enc_add(u32 rt, u32 ra, u32 rb) {
    return (31u << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((rb & 0x1F) << 11) | (266u << 1);
}

// cmpi crfD, L, ra, simm  (op 11; here L=0, crfD=0)
static u32 enc_cmpi_cr0(u32 ra, s32 simm) {
    return (11u << 26) | (0u << 23) | (0u << 21) | ((ra & 0x1F) << 16)
         | ((u32)(s32)(s16)simm & 0xFFFFu);
}

// b  target_pc  (op 18; encodes signed 26-bit displacement, AA=0, LK=lk)
static u32 enc_b(u32 cur_pc, u32 target_pc, bool lk) {
    s32 disp = (s32)target_pc - (s32)cur_pc;
    return (18u << 26) | ((u32)disp & 0x03FFFFFCu) | (lk ? 1u : 0u);
}

// bc BO, BI, target_pc  (op 16; AA=0, LK=lk)
static u32 enc_bc(u32 bo, u32 bi, u32 cur_pc, u32 target_pc, bool lk) {
    s32 disp = (s32)target_pc - (s32)cur_pc;
    return (16u << 26) | ((bo & 0x1F) << 21) | ((bi & 0x1F) << 16)
         | ((u32)disp & 0xFFFCu) | (lk ? 1u : 0u);
}

// blr  (op 19, sub-op 16, BO=20 = "branch always", BI=0)
static u32 enc_blr() {
    return (19u << 26) | (20u << 21) | (0u << 16) | (0u << 11) | (16u << 1) | 0u;
}

// bctr  (op 19, sub-op 528, BO=20 = "branch always", BI=0, LK=lk)
static u32 enc_bctr() {
    return (19u << 26) | (20u << 21) | (0u << 16) | (0u << 11) | (528u << 1) | 0u;
}

// addis rt, ra, simm  (op 15)
static u32 enc_addis(u32 rt, u32 ra, s32 simm) {
    return (15u << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((u32)(s32)(s16)simm & 0xFFFFu);
}

// ori ra, rs, uimm  (op 24; note: rA is dest, rS is source)
static u32 enc_ori(u32 ra, u32 rs, u32 uimm) {
    return (24u << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | (uimm & 0xFFFFu);
}

// rlwinm ra, rs, sh, mb, me  (op 21)
static u32 enc_rlwinm(u32 ra, u32 rs, u32 sh, u32 mb, u32 me) {
    return (21u << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((sh & 0x1F) << 11) | ((mb & 0x1F) << 6) | ((me & 0x1F) << 1);
}

// mtspr rs, spr  (op 31, sub-op 467; SPR field uses split-nibble encoding:
// bits 11-15 hold SPR[5..9], bits 16-20 hold SPR[0..4] — opposite of mfspr)
static u32 enc_mtspr(u32 spr, u32 rs) {
    const u32 spr_lo = spr & 0x1F;
    const u32 spr_hi = (spr >> 5) & 0x1F;
    return (31u << 26) | ((rs & 0x1F) << 21) | (spr_lo << 16) | (spr_hi << 11) | (467u << 1);
}

// lwz rt, offset(ra)   (op 32)
static u32 enc_lwz(u32 rt, u32 ra, s32 offset) {
    return (32u << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((u32)(s32)(s16)offset & 0xFFFFu);
}

// stw rs, offset(ra)   (op 36)
static u32 enc_stw(u32 rs, u32 ra, s32 offset) {
    return (36u << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((u32)(s32)(s16)offset & 0xFFFFu);
}

// ---------------------------------------------------------------------------
// Test harness — each test owns a fresh PowerPCState in linear memory.
// ---------------------------------------------------------------------------
struct TestEnv {
    void* ctx_raw = nullptr;
    u32 ctx_ptr = 0;
    BlockCache cache;

    bool init() {
        constexpr u32 CTX_BYTES = 0x400;
        ctx_raw = std::calloc(1, CTX_BYTES);
        if (!ctx_raw) return false;
        ctx_ptr = (u32)(uintptr_t)ctx_raw;
        return true;
    }
    ~TestEnv() { if (ctx_raw) std::free(ctx_raw); }

    u32& gpr(u32 i) { return *(u32*)((u8*)ctx_raw + ppc_off::gpr(i)); }
    u32& spr(u32 i) { return *(u32*)((u8*)ctx_raw + ppc_off::spr(i)); }
    u32& cr_field0_low()  { return *(u32*)((u8*)ctx_raw + ppc_off::cr_field(0)); }
    u32& cr_field0_high() { return *(u32*)((u8*)ctx_raw + ppc_off::cr_field(0) + 4); }

    bool dispatch_block(u32 start_pc, const u32* insts, u32 count, s32* out_next_pc) {
        // Build a sequential instr_pcs so build_block's chain_fallthrough
        // path is exercised (matches the real DecodeBlock contract).
        std::vector<u32> instr_pcs(count);
        for (u32 i = 0; i < count; ++i) instr_pcs[i] = start_pc + i * 4u;
        std::vector<u8> bytes = build_block(start_pc, insts, count, ctx_ptr,
                                            /*mem_pages=*/0, /*mem1_base=*/0,
                                            /*mem1_mask=*/0, /*ram_size=*/0,
                                            instr_pcs.data());
        int handle = cache.compile(start_pc, bytes.data(), bytes.size());
        if (handle < 0) return false;
        s32 next_pc = -1;
        if (!cache.dispatch(start_pc, &next_pc)) return false;
        if (out_next_pc) *out_next_pc = next_pc;
        return true;
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Smoke test: 3 sequential addi instructions.
static bool test_addi_sequential() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_addi(3, 0, 7),
        enc_addi(4, 0, 35),
        enc_addi(3, 3, 0),
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc)) return false;
    return next_pc == (s32)(PC + 12u) && env.gpr(3) == 7 && env.gpr(4) == 35;
}

// add rt, ra, rb (X-form integer add).
static bool test_add_register() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_addi(3, 0, 100),
        enc_addi(4, 0, 23),
        enc_add(5, 3, 4),       // r5 = 100 + 23
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc)) return false;
    return next_pc == (s32)(PC + 12u) && env.gpr(5) == 123;
}

// b LABEL (op 18, no LK). Block of one b. next_pc must be the target,
// not start_pc + 4.
static bool test_bx_unconditional() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    const u32 TARGET = 0x80004000;
    u32 insts[] = { enc_b(PC, TARGET, /*lk=*/false) };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    return next_pc == (s32)TARGET;
}

// bl LABEL (op 18, LK=1). LR must be set to PC+4.
static bool test_bx_with_link() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    const u32 TARGET = 0x80004000;
    u32 insts[] = { enc_b(PC, TARGET, /*lk=*/true) };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    return next_pc == (s32)TARGET && env.spr(8) == PC + 4u;  // SPR_LR = 8
}

// beq+ TAKEN: cmpi cr0,r3,0 with r3=0; beq+ +0x10 → branch.
static bool test_bcx_eq_taken() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    const u32 TAKEN_TARGET = PC + 0x100;
    // Pre-set r3 = 0 in the state
    env.gpr(3) = 0;
    u32 insts[] = {
        enc_cmpi_cr0(3, 0),                          // sets CR0 (r3==0 → EQ)
        enc_bc(/*BO=12 branch true*/12, /*BI=2 EQ*/2, PC + 4u, TAKEN_TARGET, false),
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 2, &next_pc)) return false;
    return next_pc == (s32)TAKEN_TARGET;
}

// beq+ NOT-TAKEN: cmpi cr0,r3,0 with r3=1; beq+ → fall through.
// next_pc must be PC+8 (after the beq), not PC (start_pc) — this is the
// bne+ chain_fallthrough emit-bug regression test.
static bool test_bcx_eq_not_taken() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    env.gpr(3) = 1;  // r3 != 0
    u32 insts[] = {
        enc_cmpi_cr0(3, 0),
        enc_bc(/*BO=12*/12, /*BI=2 EQ*/2, PC + 4u, PC + 0x100, false),
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 2, &next_pc)) return false;
    return next_pc == (s32)(PC + 8u);
}

// chain_fallthrough: cmpi; bc; addi (the bc fallthrough continues into
// the addi). When NOT taken, the addi must execute and r4 must be 42.
// When taken, r4 stays at 0. Bug pattern (commit 1cfd707): bc emit didn't
// continue the chain, leaving the addi un-emitted; trailing fallback read
// PC = pre-op set_pc(start_pc) and returned start_pc forever.
static bool test_bcx_chain_fallthrough_runs_next() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    env.gpr(3) = 1;  // ensure NOT taken
    env.gpr(4) = 0;
    u32 insts[] = {
        enc_cmpi_cr0(3, 0),
        enc_bc(12, 2, PC + 4u, PC + 0x200, false),  // beq+, not taken
        enc_addi(4, 0, 42),                          // must execute
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc)) return false;
    // Block reaches end after addi. next_pc = PC + 12 (post-addi).
    return next_pc == (s32)(PC + 12u) && env.gpr(4) == 42;
}

// blr: indirect branch via LR. Set LR via mtspr in a real ISA, but for
// the test we just pre-populate ppc_state.spr[8] and execute blr.
static bool test_blr_indirect() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    const u32 LR_TARGET = 0x80005000;
    env.spr(8) = LR_TARGET;  // pre-set LR
    u32 insts[] = { enc_blr() };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    return next_pc == (s32)LR_TARGET;
}

// Mixed: addi + b. The b unconditionally exits to a known target.
// addi must run before the b — verify r3 == 99 AND next_pc == target.
static bool test_addi_then_b() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    const u32 TARGET = 0x80007000;
    u32 insts[] = {
        enc_addi(3, 0, 99),
        enc_b(PC + 4u, TARGET, false),
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 2, &next_pc)) return false;
    return next_pc == (s32)TARGET && env.gpr(3) == 99;
}

// bctr indirect: pre-set CTR, dispatch `bctr`, verify next_pc == CTR.
// Parallels blr_indirect but uses SPR 9 (CTR) instead of SPR 8 (LR).
static bool test_bctr_indirect() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    const u32 CTR_TARGET = 0x80006000;
    env.spr(9) = CTR_TARGET;  // pre-set CTR
    u32 insts[] = { enc_bctr() };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    return next_pc == (s32)CTR_TARGET;
}

// lis r3, 0x8000 = addis r3, 0, 0x8000. Verifies addis with ra=0 sets
// r3 = simm << 16 (the conventional way to materialize a 32-bit constant).
static bool test_lis_immediate() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_addis(3, 0, 0x8000),  // r3 = 0x80000000 (sign-extended? simm is signed)
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    // Note: 0x8000 as simm sign-extends to 0xFFFF8000. 0xFFFF8000 << 16 = 0x80000000.
    return next_pc == (s32)(PC + 4u) && env.gpr(3) == 0x80000000u;
}

// ori r3, r4, 0x1234 — sets r3 to r4 | 0x1234. CodeWarrior idiom for
// completing a 32-bit constant after lis.
static bool test_ori_low_half() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_addis(4, 0, 0x1234),  // r4 = 0x12340000
        enc_ori(3, 4, 0x5678),    // r3 = r4 | 0x5678 = 0x12345678
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 2, &next_pc)) return false;
    return next_pc == (s32)(PC + 8u) && env.gpr(3) == 0x12345678u;
}

// addi with negative simm — verifies the s16 sign-extension path. With
// ra=0, addi sets rt = sign_ext(simm). The encoder packs simm as a u16,
// the emitter must sign-extend on use.
static bool test_addi_negative() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_addi(3, 0, -1),       // r3 = -1 = 0xFFFFFFFF
        enc_addi(4, 0, -32768),   // r4 = -32768 = 0xFFFF8000 (smallest s16)
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 2, &next_pc)) return false;
    return next_pc == (s32)(PC + 8u)
        && env.gpr(3) == 0xFFFFFFFFu
        && env.gpr(4) == 0xFFFF8000u;
}

// rlwinm rA, rS, SH, MB, ME — rotate-left-word-immediate-then-mask. Bit
// extraction idiom: r3 := (r4 << 4) & 0x000FF000 to extract bits [12:5]
// of an unrelated layout. Tests the rotate+mask emission.
// Pattern used: rlwinm r3, r4, 4, 12, 19 — rotate r4 left 4, keep bits
// 12..19 (in MSB ordering = mask 0x000FF000), zero everything else.
static bool test_rlwinm_extract() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_addis(4, 0, 0x1234),                  // r4 = 0x12340000
        enc_ori(4, 4, 0x5678),                    // r4 = 0x12345678
        enc_rlwinm(3, 4, /*sh=*/4, /*mb=*/12, /*me=*/19),
        // r3 = rotate_left(0x12345678, 4) & mask(12,19)
        //    = 0x23456781 & 0x000FF000
        //    = 0x00056000 (bits 12..19 of 0x23456781 are 0x56)
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc)) return false;
    return next_pc == (s32)(PC + 12u) && env.gpr(3) == 0x00056000u;
}

// mtspr LR + blr round-trip: verifies that mtspr can write LR and a
// subsequent blr reads it back as the indirect branch target.
// Pattern: addi r3, 0, 0x900; mtspr LR, r3; blr
static bool test_mtlr_then_blr() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_addi(3, 0, 0x900),    // r3 = 0x900 (s16 sign-extended → 0x900 unchanged)
        enc_mtspr(/*SPR_LR=8*/8, 3),
        enc_blr(),
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc)) return false;
    return next_pc == (s32)0x900 && env.spr(8) == 0x900u;
}

// Block with no terminator (count cap reached without hitting a branch).
// Trailing fallback emits set_pc(next_pc) + return. next_pc must be
// start_pc + count*4.
static bool test_no_terminator_block() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_addi(3, 0, 1),
        enc_addi(4, 0, 2),
        enc_addi(5, 0, 3),
        enc_addi(6, 0, 4),
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 4, &next_pc)) return false;
    return next_pc == (s32)(PC + 16u)
        && env.gpr(3) == 1 && env.gpr(4) == 2
        && env.gpr(5) == 3 && env.gpr(6) == 4;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

struct TestCase {
    const char* name;
    bool (*run)();
};

static const TestCase k_tests[] = {
    {"addi_sequential",                  &test_addi_sequential},
    {"add_register",                     &test_add_register},
    {"bx_unconditional",                 &test_bx_unconditional},
    {"bx_with_link",                     &test_bx_with_link},
    {"bcx_eq_taken",                     &test_bcx_eq_taken},
    {"bcx_eq_not_taken",                 &test_bcx_eq_not_taken},
    {"bcx_chain_fallthrough_runs_next",  &test_bcx_chain_fallthrough_runs_next},
    {"blr_indirect",                     &test_blr_indirect},
    {"addi_then_b",                      &test_addi_then_b},
    {"no_terminator_block",              &test_no_terminator_block},
    {"bctr_indirect",                    &test_bctr_indirect},
    {"lis_immediate",                    &test_lis_immediate},
    {"ori_low_half",                     &test_ori_low_half},
    {"addi_negative",                    &test_addi_negative},
    {"rlwinm_extract",                   &test_rlwinm_extract},
    {"mtlr_then_blr",                    &test_mtlr_then_blr},
};

int main() {
    // Install JS-side stubs for the 9 PowerPC host imports the emitter
    // declares. Most corpus tests don't touch memory or fall back to
    // interpreter, so trivial no-op stubs satisfy import linkage.
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

    int pass = 0, fail = 0;
    char buf[128];
    for (const auto& tc : k_tests) {
        bool ok = tc.run();
        std::snprintf(buf, sizeof(buf), "%s", tc.name);
        report(buf, ok);
        if (ok) pass++; else fail++;
    }
    std::snprintf(buf, sizeof(buf), "TOTAL: %d passed, %d failed", pass, fail);
    report(buf, fail == 0);
    return fail == 0 ? 0 : 1;
}
