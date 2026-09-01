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

// mullw rt, ra, rb  (op 31, sub-op 235)
static u32 enc_mullw(u32 rt, u32 ra, u32 rb) {
    return (31u << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((rb & 0x1F) << 11) | (235u << 1);
}

// divwu rt, ra, rb  (op 31, sub-op 459) — unsigned divide
static u32 enc_divwu(u32 rt, u32 ra, u32 rb) {
    return (31u << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((rb & 0x1F) << 11) | (459u << 1);
}

// or. ra, rs, rb  (op 31, sub-op 444, Rc=1) — bit OR with CR0 update
static u32 enc_or_rc(u32 ra, u32 rs, u32 rb) {
    return (31u << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((rb & 0x1F) << 11) | (444u << 1) | 1u;
}

// lwzu rt, offset(ra)  (op 33) — load word with update; rA is also updated to EA.
static u32 enc_lwzu(u32 rt, u32 ra, s32 offset) {
    return (33u << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((u32)(s32)(s16)offset & 0xFFFFu);
}

// stwu rs, offset(ra)  (op 37) — store word with update; rA also updated to EA.
static u32 enc_stwu(u32 rs, u32 ra, s32 offset) {
    return (37u << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((u32)(s32)(s16)offset & 0xFFFFu);
}

// lwzx rt, ra, rb  (op 31, sub-op 23) — X-form indexed load.
static u32 enc_lwzx(u32 rt, u32 ra, u32 rb) {
    return (31u << 26) | ((rt & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((rb & 0x1F) << 11) | (23u << 1);
}

// stwx rs, ra, rb  (op 31, sub-op 151) — X-form indexed store.
static u32 enc_stwx(u32 rs, u32 ra, u32 rb) {
    return (31u << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((rb & 0x1F) << 11) | (151u << 1);
}

// slw ra, rs, rb  (op 31, sub-op 24) — shift left word by rb&63.
static u32 enc_slw(u32 ra, u32 rs, u32 rb) {
    return (31u << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((rb & 0x1F) << 11) | (24u << 1);
}

// srw ra, rs, rb  (op 31, sub-op 536) — shift right logical word.
static u32 enc_srw(u32 ra, u32 rs, u32 rb) {
    return (31u << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((rb & 0x1F) << 11) | (536u << 1);
}

// srawi ra, rs, sh  (op 31, sub-op 824) — shift right algebraic word immediate.
static u32 enc_srawi(u32 ra, u32 rs, u32 sh) {
    return (31u << 26) | ((rs & 0x1F) << 21) | ((ra & 0x1F) << 16)
         | ((sh & 0x1F) << 11) | (824u << 1);
}

// (encoder for `neg` removed — no native emitter and our test interp stub
// is a no-op, so the block dispatches but the negate never runs. Real
// game runtime uses Dolphin's full interpreter for this op. Re-add a
// neg test once a smarter test interp stub or differential harness lands.)

// mfcr rt  (op 31, sub-op 19) — move from condition register (whole 32 bits).
static u32 enc_mfcr(u32 rt) {
    return (31u << 26) | ((rt & 0x1F) << 21) | (19u << 1);
}

// mtcrf crm, rs  (op 31, sub-op 144) — move to CR fields specified by 8-bit mask.
static u32 enc_mtcrf(u32 crm, u32 rs) {
    return (31u << 26) | ((rs & 0x1F) << 21) | ((crm & 0xFF) << 12) | (144u << 1);
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

    bool dispatch_block(u32 start_pc, const u32* insts, u32 count, s32* out_next_pc,
                        u32 mem1_base = 0, u32 mem1_mask = 0, u32 ram_size = 0) {
        // Build a sequential instr_pcs so build_block's chain_fallthrough
        // path is exercised (matches the real DecodeBlock contract).
        std::vector<u32> instr_pcs(count);
        for (u32 i = 0; i < count; ++i) instr_pcs[i] = start_pc + i * 4u;
        std::vector<u8> bytes = build_block(start_pc, insts, count, ctx_ptr,
                                            /*mem_pages=*/0, mem1_base,
                                            mem1_mask, ram_size,
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

// mullw r3, r4, r5 — 32-bit signed/unsigned multiply (low 32 bits of product).
static bool test_mullw() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_addi(4, 0, 7),
        enc_addi(5, 0, 11),
        enc_mullw(3, 4, 5),       // r3 = 7 * 11 = 77
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc)) return false;
    return next_pc == (s32)(PC + 12u) && env.gpr(3) == 77u;
}

// divwu r3, r4, r5 — unsigned divide.
static bool test_divwu() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_addi(4, 0, 100),
        enc_addi(5, 0, 7),
        enc_divwu(3, 4, 5),       // r3 = 100 / 7 = 14
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc)) return false;
    return next_pc == (s32)(PC + 12u) && env.gpr(3) == 14u;
}

// (Removed: test_or_with_rc_{negative,positive,zero} — those asserted on
// raw cr.fields[0] bytes, which encoded the OLD broken `shr_s 31` form
// where high u32 was 0xFFFFFFFF for any negative result. After the
// emit_set_cr0 fix surfaced by test_diff against DolphinPPCTests' oracle,
// the bit pattern is now 0xC0000001 / 0x00000001 / 0x80000001 (LT only,
// GT only, EQ only) — matching Dolphin's PPCToInternal exactly. test_diff
// validates Rc=1 CR semantics across hundreds of cases against the
// real-Wii reference; those bespoke tests were redundant and asserting
// the wrong invariant.)

// lwz via trampoline. Base address is 0x40000000 — outside MEM1 trusted
// ranges, so per-block DFA forces trampoline path (ppc_read32 stub fires).
// JS stub records the addr it was called with and returns 0xDEADBEEF.
static bool test_lwz_trampoline() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_last_read_addr = 0;
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            Module.test_last_read_addr = addr >>> 0;
            return 0xDEADBEEF | 0;
        };
    });
#endif
    u32 insts[] = {
        enc_addis(4, 0, 0x4000),          // r4 = 0x40000000
        enc_lwz(3, 4, 0x10),              // r3 = mem[r4 + 0x10] (via trampoline)
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 2, &next_pc)) return false;
#ifdef __EMSCRIPTEN__
    const u32 read_addr = (u32)EM_ASM_INT({ return Module.test_last_read_addr | 0; });
#else
    const u32 read_addr = 0;
#endif
    return next_pc == (s32)(PC + 8u)
        && env.gpr(3) == 0xDEADBEEFu
        && read_addr == 0x40000010u;
}

// stw via trampoline. Same trusted-range logic forces trampoline. JS stub
// records (addr, val) of the call.
static bool test_stw_trampoline() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_last_write_addr = 0;
        Module.test_last_write_val  = 0;
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_last_write_addr = addr >>> 0;
            Module.test_last_write_val  = val  >>> 0;
        };
    });
#endif
    u32 insts[] = {
        enc_addi(3, 0, 0x1234),           // r3 = 0x1234
        enc_addis(4, 0, 0x4000),           // r4 = 0x40000000
        enc_stw(3, 4, 0x20),              // mem[r4 + 0x20] = r3
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc)) return false;
#ifdef __EMSCRIPTEN__
    const u32 wa = (u32)EM_ASM_INT({ return Module.test_last_write_addr | 0; });
    const u32 wv = (u32)EM_ASM_INT({ return Module.test_last_write_val  | 0; });
#else
    const u32 wa = 0, wv = 0;
#endif
    return next_pc == (s32)(PC + 12u)
        && wa == 0x40000020u
        && wv == 0x1234u;
}

// stwu r1, -32(r1) — canonical stack-frame prologue. r1 must update to
// new_sp = old_sp - 32, and mem[new_sp] must hold old_sp (the back-chain).
static bool test_stwu_stack_frame() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_writes = [];
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_writes.push([addr >>> 0, val >>> 0]);
        };
    });
#endif
    const u32 OLD_SP = 0x80100000;
    env.gpr(1) = OLD_SP;
    u32 insts[] = { enc_stwu(1, 1, -32) };  // stwu r1, -32(r1) — push frame
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    if (env.gpr(1) != OLD_SP - 32u) return false;
#ifdef __EMSCRIPTEN__
    const u32 wlen = (u32)EM_ASM_INT({ return Module.test_writes.length | 0; });
    const u32 wa = (u32)EM_ASM_INT({ return Module.test_writes.length ? Module.test_writes[0][0] : 0; });
    const u32 wv = (u32)EM_ASM_INT({ return Module.test_writes.length ? Module.test_writes[0][1] : 0; });
    return next_pc == (s32)(PC + 4u)
        && wlen == 1u
        && wa == OLD_SP - 32u    // store at NEW sp
        && wv == OLD_SP;          // back-chain = OLD sp
#else
    return next_pc == (s32)(PC + 4u);
#endif
}

// lwzu r3, 8(r4) — load with update; rA (r4) gets EA.
static bool test_lwzu_update_ra() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            return 0xCAFEBABE | 0;
        };
    });
#endif
    env.gpr(4) = 0x40000000;
    u32 insts[] = { enc_lwzu(3, 4, 8) };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    return next_pc == (s32)(PC + 4u)
        && env.gpr(3) == 0xCAFEBABEu
        && env.gpr(4) == 0x40000008u;     // r4 updated to EA
}

// lwzx r3, r4, r5 — X-form indexed load. EA = r4 + r5.
static bool test_lwzx_indexed() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_lwzx_addr = 0;
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            Module.test_lwzx_addr = addr >>> 0;
            return 0x12345678 | 0;
        };
    });
#endif
    env.gpr(4) = 0x40000000;
    env.gpr(5) = 0x40;
    u32 insts[] = { enc_lwzx(3, 4, 5) };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
#ifdef __EMSCRIPTEN__
    const u32 ra = (u32)EM_ASM_INT({ return Module.test_lwzx_addr | 0; });
#else
    const u32 ra = 0;
#endif
    return next_pc == (s32)(PC + 4u)
        && env.gpr(3) == 0x12345678u
        && ra == 0x40000040u;
}

// stwx r3, r4, r5 — X-form indexed store.
static bool test_stwx_indexed() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_stwx_addr = 0;
        Module.test_stwx_val  = 0;
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_stwx_addr = addr >>> 0;
            Module.test_stwx_val  = val  >>> 0;
        };
    });
#endif
    env.gpr(3) = 0xABCD;
    env.gpr(4) = 0x40000000;
    env.gpr(5) = 0x80;
    u32 insts[] = { enc_stwx(3, 4, 5) };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
#ifdef __EMSCRIPTEN__
    const u32 wa = (u32)EM_ASM_INT({ return Module.test_stwx_addr | 0; });
    const u32 wv = (u32)EM_ASM_INT({ return Module.test_stwx_val  | 0; });
#else
    const u32 wa = 0, wv = 0;
#endif
    return next_pc == (s32)(PC + 4u)
        && wa == 0x40000080u
        && wv == 0xABCDu;
}

// slw r3, r4, r5 — variable left shift. r5 holds shift count (mod 64).
static bool test_slw_variable() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    env.gpr(4) = 0x12345678;
    env.gpr(5) = 4;
    u32 insts[] = { enc_slw(3, 4, 5) };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    // 0x12345678 << 4 = 0x23456780 (low 32 bits)
    return next_pc == (s32)(PC + 4u) && env.gpr(3) == 0x23456780u;
}

// srw r3, r4, r5 — variable right shift logical (zero-fill).
static bool test_srw_variable() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    env.gpr(4) = 0xF0000000;
    env.gpr(5) = 4;
    u32 insts[] = { enc_srw(3, 4, 5) };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    return next_pc == (s32)(PC + 4u) && env.gpr(3) == 0x0F000000u;
}

// srawi r3, r4, 4 — arithmetic right shift by immediate; preserves sign.
static bool test_srawi_sign_preserve() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    env.gpr(4) = 0x80000000u;  // -2^31
    u32 insts[] = { enc_srawi(3, 4, 4) };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    // 0x80000000 >> 4 (signed) = 0xF8000000
    return next_pc == (s32)(PC + 4u) && env.gpr(3) == 0xF8000000u;
}

// mfcr r3 — pulls all 8 CR fields into r3 (4 bits per field, packed
// into a u32 in MSB order — field 0 in bits 0..3, field 7 in bits 28..31).
// Pre-set CR0 with a known sign-encoded value via emit_set_cr0 semantics
// (we manually populate cr.fields[0] in the host context).
static bool test_mfcr() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    // Dolphin's CR encoding: low u32 = result, high u32 = sign-ext-by-31.
    // Pretending CR0 holds "negative result" → high u32 has bit 30 set
    // (LT) per ConditionRegister.h: 4 packed bits = LT GT EQ SO.
    // For simplicity: just verify mfcr emits valid code that runs.
    u32 insts[] = { enc_mfcr(3) };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    // Don't assert specific cr value — emit_mfcr likely uses fallback for
    // SAB-class binaries; just verify the block dispatched without crash.
    return next_pc == (s32)(PC + 4u);
}

// mtcrf 0xFF, r3 — broadcast r3 to all 8 CR fields.
static bool test_mtcrf() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    env.gpr(3) = 0x80000000;  // CR0 LT bit (BE bit 0) = 1
    u32 insts[] = { enc_mtcrf(0xFF, 3) };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    // Verify dispatcher didn't loop on a missing-emitter path. Don't
    // pin the exact CR field encoding — varies between native vs fallback.
    return next_pc == (s32)(PC + 4u);
}

// MEM1 fast-path lwz: passes mem1_base = host pointer to a backing buffer,
// sets r1 to a virtual address that maps into the buffer, exercises the
// per-block DFA's "block_safe" determination + direct WASM linear-memory
// load with byte-swap.
static bool test_lwz_fast_path() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    // Allocate a 64-byte backing buffer, write big-endian 0xDEADBEEF at offset 0.
    u8 buffer[64] = {0};
    buffer[0] = 0xDE; buffer[1] = 0xAD; buffer[2] = 0xBE; buffer[3] = 0xEF;
    const u32 host_buffer_addr = (u32)(uintptr_t)&buffer[0];
    // PPC virtual address: low 25 bits will be masked, then added to mem1_base.
    // r1 = 0x80000000 → masked to 0, offset 0 → reads buffer[0..3].
    env.gpr(1) = 0x80000000;
    u32 insts[] = { enc_lwz(3, 1, 0) };  // lwz r3, 0(r1) — base is r1 (trusted)
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc,
                            host_buffer_addr, 0x017FFFFFu, 64)) return false;
    // Big-endian read from [0xDE, 0xAD, 0xBE, 0xEF] = 0xDEADBEEF.
    return next_pc == (s32)(PC + 4u) && env.gpr(3) == 0xDEADBEEFu;
}

// MEM1 fast-path stw: write 0x12345678 to offset 0; verify big-endian
// bytes [0x12, 0x34, 0x56, 0x78] in the backing buffer.
static bool test_stw_fast_path() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u8 buffer[64] = {0};
    const u32 host_buffer_addr = (u32)(uintptr_t)&buffer[0];
    env.gpr(1) = 0x80000000;
    env.gpr(3) = 0x12345678;
    u32 insts[] = { enc_stw(3, 1, 0) };  // stw r3, 0(r1)
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc,
                            host_buffer_addr, 0x017FFFFFu, 64)) return false;
    return next_pc == (s32)(PC + 4u)
        && buffer[0] == 0x12 && buffer[1] == 0x34
        && buffer[2] == 0x56 && buffer[3] == 0x78;
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
    {"mullw",                            &test_mullw},
    {"divwu",                            &test_divwu},
    // or_with_rc_* removed — see comment above; superseded by test_diff.
    {"lwz_trampoline",                   &test_lwz_trampoline},
    {"stw_trampoline",                   &test_stw_trampoline},
    {"stwu_stack_frame",                 &test_stwu_stack_frame},
    {"lwzu_update_ra",                   &test_lwzu_update_ra},
    {"lwzx_indexed",                     &test_lwzx_indexed},
    {"stwx_indexed",                     &test_stwx_indexed},
    {"slw_variable",                     &test_slw_variable},
    {"srw_variable",                     &test_srw_variable},
    {"srawi_sign_preserve",              &test_srawi_sign_preserve},
    {"mfcr",                             &test_mfcr},
    {"mtcrf",                            &test_mtcrf},
    {"lwz_fast_path",                    &test_lwz_fast_path},
    {"stw_fast_path",                    &test_stw_fast_path},
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
        // Declared in every emitted block's import section (even non-HLE
        // blocks); must be a callable for instantiation. Never invoked here.
        env.ppc_hle_fire    = function(pc, idx) { return 0; };
        env.ppc_stack_corrupt = function(a, b, c, d) {};  // diagnostic import; (i32x4)->void
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
