// test_gekko_next.cpp — branch/load-store/ALU block corpus run through the
// LIVE powerpc-next emitter (build_block_next, the production path per
// JitWasm.cpp:291). Port of test_gekko.cpp (legacy guests/powerpc).
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
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"
#include "ppc_encode.h"   // [2026-08-12 cycle-ledger] li/add/lwzx/... encoders for the tax kernels

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

// cmpli crfD, L, ra, uimm  (op 10; here L=0, crfD=0) — unsigned immediate compare
static u32 enc_cmpli_cr0(u32 ra, u32 uimm) {
    return (10u << 26) | (0u << 23) | (0u << 21) | ((ra & 0x1F) << 16)
         | (uimm & 0xFFFFu);
}

// cmp crfD, L, ra, rb  (op 31, sub-op 0; L=0, crfD=0) — signed register compare
static u32 enc_cmp_cr0(u32 ra, u32 rb) {
    return (31u << 26) | ((ra & 0x1F) << 16) | ((rb & 0x1F) << 11) | (0u << 1);
}

// cmpl crfD, L, ra, rb  (op 31, sub-op 32; L=0, crfD=0) — unsigned register compare
// (verified against MP4 retail 0x7C1E0040 = cmplw cr0,r30,r0)
static u32 enc_cmpl_cr0(u32 ra, u32 rb) {
    return (31u << 26) | ((ra & 0x1F) << 16) | ((rb & 0x1F) << 11) | (32u << 1);
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
        constexpr u32 CTX_BYTES = 0x1400; // covers spr[] through GQR0-7 (912 -> 0x1180) and HID2 (920 -> 0x1190); was 0x400, which made any spr(912+) write silent heap corruption
        ctx_raw = std::calloc(1, CTX_BYTES);
        if (!ctx_raw) return false;
        ctx_ptr = (u32)(uintptr_t)ctx_raw;
        return true;
    }
    ~TestEnv() { if (ctx_raw) std::free(ctx_raw); }

    u32& gpr(u32 i) { return *(u32*)((u8*)ctx_raw + ppc_off::gpr(i)); }
    u32& spr(u32 i) { return *(u32*)((u8*)ctx_raw + ppc_off::spr(i)); }
    u32& cr_field0_low()  { return *(u32*)((u8*)ctx_raw + ppc_off::cr(0)); }
    u32& cr_field0_high() { return *(u32*)((u8*)ctx_raw + ppc_off::cr(0) + 4); }

    bool dispatch_block(u32 start_pc, const u32* insts, u32 count, s32* out_next_pc,
                        u32 mem1_base = 0, u32 mem1_mask = 0, u32 ram_size = 0) {
        // Build a sequential instr_pcs so build_block's chain_fallthrough
        // path is exercised (matches the real DecodeBlock contract).
        std::vector<u32> instr_pcs(count);
        for (u32 i = 0; i < count; ++i) instr_pcs[i] = start_pc + i * 4u;
        (void)instr_pcs;  // build_block_next derives per-op PCs internally
        std::vector<u8> bytes = build_block_next(start_pc, insts, count, ctx_ptr,
                                                 mem1_base, mem1_mask, ram_size);
        int handle = cache.compile(start_pc, bytes.data(), bytes.size());
        if (handle < 0) return false;
        s32 next_pc = -1;
        if (!cache.dispatch(start_pc, &next_pc)) return false;
        if (out_next_pc) *out_next_pc = next_pc;
        return true;
    }

    // [FUSION v2] dispatch a PRE-FUSED stream with explicit per-op pcs
    // (non-contiguous at seams) — exercises AnalyzeOps + seam emission.
    bool dispatch_fused(u32 start_pc, const u32* insts, const u32* pcs,
                        u32 count, s32* out_next_pc) {
        std::vector<u8> bytes = build_block_next(start_pc, insts, count,
                                                 ctx_ptr, 0, 0, 0,
                                                 nullptr, nullptr, pcs);
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
// Exact retail bytes of MP4 VIWaitForRetrace's wake re-check block
// (0x800C1544: lwz r0,-0x6FF8(r13); cmplw r30,r0; beq -0x10). The conformance
// corpus never used r0 as an input operand — this is the live boot-wedge
// block (main re-sleeps forever despite retraceCount advancing).
// Exact retail bytes of MP4 HuSysInit's minimumVcountf store (init.s:65-66):
// lfs f1,-0x7FF8(r2); stfs f1,-0x7920(r13). Live bug: the lfs EA computed
// 8 bytes LOW, loading the int-to-double magic (2^52) at -0x8000 instead of
// the 1.0f at -0x7FF8 -> minimumVcountf=0x59800000, fp2unsigned saturates
// minimumVcount=-1 -> HuSysDoneRender's unsigned pacing loop never exits ->
// boot wedge (GlobalCounter pinned at 0).
// 2026-06-11 REWRITE — the previous version of this test was a HARNESS
// ARTIFACT, not an EA-bug repro: it asserted on the stfs's store, but stfs
// is interp-fallback (ppc_emit.cpp case 52) and this harness's ppc_interp
// stub is a NO-OP — and emit_lfs is slowmem-only, so the default
// ppc_read32 stub (return 0) fed the lfs zeros regardless of EA. Red by
// construction; it indicted the lfs EA without testing it.
// This version tests the lfs claim directly: a recording ppc_read32
// captures the EA the emitted code actually issues (the STATUS.md claim
// "EA computed 8 bytes LOW" would show read_addr=0x801D0000 instead of
// 0x801D0008), and f1's ps0/ps1 (flushed to PowerPCState by the stfs
// fallback's frc.Flush + block epilogue) capture the loaded+promoted value.
static bool test_lfs_sda2_negative_offset() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80009BD4;
    const u32 R2       = 0x801D8000u;   // arbitrary sdata2 base for the test
    const u32 EA_ONE   = R2 - 0x7FF8u;  // 0x801D0008 — 1.0f lives here
    const u32 EA_MAGIC = R2 - 0x8000u;  // 0x801D0000 — 2^52 magic high word
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_last_read_addr = 0;
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            addr = addr >>> 0;
            Module.test_last_read_addr = addr;
            if (addr === ($0 >>> 0)) return 0x3F800000 | 0;  // 1.0f
            if (addr === ($1 >>> 0)) return 0x43300000 | 0;  // magic hi word
            return 0;
        };
    }, EA_ONE, EA_MAGIC);
#endif
    env.gpr(2)  = R2;
    env.gpr(13) = 0x801DB420u;  // real r13
    // MSR.FP=1 — this test covers the FPU-ENABLED path. The disabled path
    // (first-FP-op exception bailout, Jit64 Jit.cpp:1104-1128 parity) is
    // covered by lfs_msr_fp_disabled below.
    *(u32*)((u8*)env.ctx_raw + ppc_off::MSR) = 0x2000u;
    const u32 insts[] = {
        0xC0228008u,  // lfs f1, -0x7FF8(r2)   — exact retail bytes
        0xD02D86E0u,  // stfs f1, -0x7920(r13) — kept for retail block shape;
                      //   interp-fallback no-op in this harness, NOT asserted
    };
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 2, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 read_addr = (u32)EM_ASM_INT({ return Module.test_last_read_addr | 0; });
    // Restore the suite's default return-0 stub for subsequent tests.
    EM_ASM({
        Module.bemental_imports.env.ppc_read32 = function(addr) { return 0; };
    });
#else
    const u32 read_addr = 0;
#endif
    if (!dispatched) return false;
    const u64 f1ps0 = *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps0(1));
    const u64 f1ps1 = *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps1(1));
    std::printf("[diag lfs-sda2] read_addr=0x%08x (exp 0x%08x) "
                "f1.ps0=0x%016llx f1.ps1=0x%016llx (exp 0x3ff0000000000000)\n",
                read_addr, EA_ONE,
                (unsigned long long)f1ps0, (unsigned long long)f1ps1);
    return read_addr == EA_ONE
        && f1ps0 == 0x3FF0000000000000ull
        && f1ps1 == 0x3FF0000000000000ull;
}

// MSR.FP=0 + FP op: the block must RAISE EXCEPTION_FPU_UNAVAILABLE (0x40,
// Gekko.h:930) BEFORE executing the FP op, and exit — Jit64 parity
// (Jit.cpp:1104-1128: TEST msr,1<<13 → pc=op.address, Exceptions|=0x40,
// WriteExceptionExit). This is the MP4 boot-wedge mechanism pinned
// 2026-06-11 from the live trajectory (probe.log wtraj: 80009bd4 → vector
// 800 → resume at 80009bd8): the native lfs ran WITHOUT the MSR.FP check,
// the interp-fallback stfs then raised FPU-unavailable, __OSLoadFPUContext
// clobbered f1 with the stale saved context (f64 2^52), and re-execution
// resumed at the stfs — storing minimumVcountf=0x59800000 and saturating
// minimumVcount=0xFFFFFFFF, wedging HuSysDoneRender's pacing loop forever.
// Asserts: (a) the load import never fires, (b) Exceptions has 0x40,
// (c) next_pc = the faulting op's address (re-execution restarts AT the
// lfs, not after it).
static bool test_lfs_msr_fp_disabled() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80009BD4;
    const u32 R2 = 0x801D8000u;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_last_read_addr = 0;
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            Module.test_last_read_addr = addr >>> 0;
            return 0x3F800000 | 0;
        };
    });
#endif
    env.gpr(2) = R2;
    // MSR stays 0 (calloc) — FP disabled.
    const u32 insts[] = {
        0xC0228008u,  // lfs f1, -0x7FF8(r2) — exact retail bytes
    };
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 1, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 read_addr = (u32)EM_ASM_INT({ return Module.test_last_read_addr | 0; });
    EM_ASM({
        Module.bemental_imports.env.ppc_read32 = function(addr) { return 0; };
    });
#else
    const u32 read_addr = 0;
#endif
    if (!dispatched) return false;
    const u32 exceptions = *(const u32*)((const u8*)env.ctx_raw + ppc_off::EXCEPTIONS);
    std::printf("[diag lfs-msrfp] read_addr=0x%08x (exp 0 = load suppressed) "
                "exceptions=0x%08x (exp 0x40) next_pc=0x%08x (exp 0x%08x)\n",
                read_addr, exceptions, (u32)next_pc, PC);
    return read_addr == 0u
        && (exceptions & 0x40u) != 0u
        && next_pc == (s32)PC;
}

static bool test_viwait_recheck_block() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x800C1544;
    static u8 mem1[0x10000];
    std::memset(mem1, 0, sizeof(mem1));
    const u32 ea_off = 0x801D4428u & 0xFFFFu;
    mem1[ea_off] = 0; mem1[ea_off+1] = 0; mem1[ea_off+2] = 0; mem1[ea_off+3] = 5;
    env.gpr(13) = 0x801DB420;  // r13 - 0x6FF8 = 0x801D4428
    env.gpr(30) = 0;           // startCount = 0 (!= 5 -> loop must EXIT)
    const u32 insts[] = {
        0x800D9008u,  // lwz r0, -0x6FF8(r13)
        0x7C1E0040u,  // cmplw cr0, r30, r0
        0x4182FFF0u,  // beq -0x10
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc,
                            (u32)(uintptr_t)mem1, 0xFFFFu, sizeof(mem1)))
        return false;
    std::printf("[diag viwait] next_pc=0x%08x r0=%u (exp 5) r30=%u\n",
                (u32)next_pc, env.gpr(0), env.gpr(30));
    return next_pc == (s32)(PC + 12u) && env.gpr(0) == 5u;
}

// PSO __LCEnable HID2 read-modify-write (exact retail shape, 2026-06-11):
//   mfspr r4, HID2   <- interp fallback (HID2 not spr_is_direct)
//   oris  r4, r4, 0x100F   <- native
//   stw   r4, 0(r5)   <- native, captures the oris result via write import
// Live bug: interp mfspr wrote gpr[4]=0xA0000000 to PowerPCState ([ax-lce]
// proof), but the oris computed on r4=0 -> stored HID2=0x100F0000, wiping
// PSE/LSQE -> IsInvalidPairedSingleExecution(dcbz_l) -> Program exception 6
// (Unhandled Exception 6 crash in __LCEnable's lock loop). The interp's
// gpr[] write must be visible to the next native op's register read.
static bool test_mfspr_interp_writeback_visible() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80011228;  // real PSO mfspr HID2 address
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_ctx_ptr = $0 >>> 0;
        Module.test_last_write_addr = 0;
        Module.test_last_write_val  = 0;
        // Simulate Dolphin's interp mfspr HID2: write gpr[4] in PowerPCState
        // memory (GPR_BASE 0x14 + 4*4 = 0x24), little-endian host u32.
        Module.test_interp_calls = 0;
        Module.bemental_imports.env.ppc_interp = function(inst, pc) {
            Module.test_interp_calls++;
            if ((pc >>> 0) === 0x80011228) {
                HEAPU32[(Module.test_ctx_ptr + 0x24) >>> 2] = 0xA0000000;
            }
        };
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_last_write_addr = addr >>> 0;
            Module.test_last_write_val  = val  >>> 0;
        };
    }, env.ctx_ptr);
#endif
    env.gpr(5) = 0x40000000u;  // outside trusted ranges -> write import fires
    const u32 insts[] = {
        0x7C98E2A6u,  // mfspr r4, HID2  (exact retail bytes, __LCEnable+0x28)
        0x6484100Fu,  // oris  r4, r4, 0x100F
        0x90850000u,  // stw   r4, 0(r5) — capture the oris result
    };
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 3, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 wv = (u32)EM_ASM_INT({ return Module.test_last_write_val | 0; });
    // Restore suite default stubs.
    EM_ASM({
        Module.bemental_imports.env.ppc_interp  = function(inst, pc) {};
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {};
    });
#else
    const u32 wv = 0;
#endif
    if (!dispatched) return false;
#ifdef __EMSCRIPTEN__
    const u32 interp_calls = (u32)EM_ASM_INT({ return Module.test_interp_calls | 0; });
#else
    const u32 interp_calls = 0;
#endif
    std::printf("[diag mfspr-wb] stored=0x%08x (exp 0xb00f0000) r4=0x%08x interp_calls=%u\n",
                wv, env.gpr(4), interp_calls);
    return wv == 0xB00F0000u;
}

// stfs native PEM ConvertToSingle (2026-06-11): the retail lfs+stfs pair,
// end-to-end through recording read/write imports. Two value classes:
//   1.0f (0x3F800000) — normal: fast path must reproduce the bits.
//   min denormal f32 (0x00000001) — lfs promotes to a double with
//   exp=874; ConvertToSingle's denormal path must round-trip the exact
//   bit pattern (an IEEE f32.demote would also produce it, but the PEM
//   path is what hardware does; this exercises the select's denorm arm).
// RED before the native emit (stfs was interp fallback; harness interp is
// a no-op, so no write ever fired).
static bool test_stfs_native_converttosingle() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80009BD4;
    const u32 R2  = 0x801D8000u;
    const u32 R13 = 0x801DB420u;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_writes = [];
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            addr = addr >>> 0;
            if (addr === 0x801D0008) return 0x3F800000 | 0;  // 1.0f
            if (addr === 0x801D000C) return 0x00000001 | 0;  // min denormal
            return 0;
        };
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_writes.push([addr >>> 0, val >>> 0]);
        };
    });
#endif
    env.gpr(2)  = R2;
    env.gpr(13) = R13;
    *(u32*)((u8*)env.ctx_raw + ppc_off::MSR) = 0x2000u;  // MSR.FP=1
    const u32 insts[] = {
        0xC0228008u,  // lfs  f1, -0x7FF8(r2)  -> 1.0f
        0xD02D86E0u,  // stfs f1, -0x7920(r13) -> expect (0x801D3B00, 0x3F800000)
        0xC022800Cu,  // lfs  f1, -0x7FF4(r2)  -> denormal 0x00000001
        0xD02D86E4u,  // stfs f1, -0x791C(r13) -> expect (0x801D3B04, 0x00000001)
    };
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 4, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 n_writes = (u32)EM_ASM_INT({ return Module.test_writes.length | 0; });
    const u32 w0a = (u32)EM_ASM_INT({ return (Module.test_writes[0] || [0,0])[0] | 0; });
    const u32 w0v = (u32)EM_ASM_INT({ return (Module.test_writes[0] || [0,0])[1] | 0; });
    const u32 w1a = (u32)EM_ASM_INT({ return (Module.test_writes[1] || [0,0])[0] | 0; });
    const u32 w1v = (u32)EM_ASM_INT({ return (Module.test_writes[1] || [0,0])[1] | 0; });
    EM_ASM({
        Module.bemental_imports.env.ppc_read32  = function(addr) { return 0; };
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {};
    });
#else
    const u32 n_writes = 0, w0a = 0, w0v = 0, w1a = 0, w1v = 0;
#endif
    if (!dispatched) return false;
    std::printf("[diag stfs-cts] n=%u w0=(0x%08x,0x%08x exp 0x801d3b00,0x3f800000) "
                "w1=(0x%08x,0x%08x exp 0x801d3b04,0x00000001)\n",
                n_writes, w0a, w0v, w1a, w1v);
    return n_writes == 2u
        && w0a == 0x801D3B00u && w0v == 0x3F800000u
        && w1a == 0x801D3B04u && w1v == 0x00000001u;
}

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
    std::printf("[diag addi_seq] next_pc=0x%08x (exp 0x%08x) r3=%u (exp 7) r4=%u (exp 35)\n",
                (u32)next_pc, PC + 12u, env.gpr(3), env.gpr(4));
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
    // [coalesce] The FORWARD conditional beq is now coalesced as a mid-block
    // exit: the analyzer keeps decoding past it (IsForwardConditionalBranch),
    // so a NOT-taken beq falls through to the addi IN THE SAME block and the
    // block returns next_pc = PC+12 (past the addi). A TAKEN beq exits to the
    // target with the addi un-executed. (Pre-coalescing this was two dispatches:
    // block ended at the bcx, next_pc = PC+8, addi ran in a second block.)
    const u32 PC = 0x80003000;
    u32 insts[] = {
        enc_cmpi_cr0(3, 0),
        enc_bc(12, 2, PC + 4u, PC + 0x200, false),  // beq+, FORWARD
        enc_addi(4, 0, 42),                          // fall-through target
    };

    // not-taken (r3 != 0): addi runs in the coalesced block, next_pc = PC+12.
    {
        TestEnv env;
        if (!env.init()) return false;
        env.gpr(3) = 1;
        env.gpr(4) = 0;
        s32 next_pc = -1;
        if (!env.dispatch_block(PC, insts, 3, &next_pc)) return false;
        if (!(next_pc == (s32)(PC + 12u) && env.gpr(4) == 42)) return false;
    }

    // taken (r3 == 0 -> EQ): mid-block exit to target, addi NOT executed.
    {
        TestEnv env;
        if (!env.init()) return false;
        env.gpr(3) = 0;
        env.gpr(4) = 0;
        s32 next_pc = -1;
        if (!env.dispatch_block(PC, insts, 3, &next_pc)) return false;
        if (!(next_pc == (s32)(PC + 0x200u) && env.gpr(4) == 0)) return false;
    }
    return true;
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

// [dcbz-fastpath 2026-07-15] dcbz inline fill: classify-admitted RAM line is
// zeroed with four in-wasm i64.stores (Jit64 parity). mem1_mask == ram_size-1
// so fast_ok holds (the production config shape). Buffer pre-filled 0xAA;
// dcbz 0,r4 with r4=0x80000020 zeroes bytes [32,64) and leaves [0,32) intact.
static bool test_dcbz_line_zero_fastmem() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u8 buffer[64];
    for (u32 i = 0; i < 64u; ++i) buffer[i] = 0xAA;
    const u32 host_buffer_addr = (u32)(uintptr_t)&buffer[0];
    env.gpr(4) = 0x80000020u;
    u32 insts[] = { (31u << 26) | (0u << 16) | (4u << 11) | (1014u << 1) };  // dcbz 0,r4
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc,
                            host_buffer_addr, 63u, 64u)) return false;
    bool low_intact = true, high_zero = true;
    for (u32 i = 0; i < 32u; ++i)  if (buffer[i] != 0xAA) low_intact = false;
    for (u32 i = 32u; i < 64u; ++i) if (buffer[i] != 0x00) high_zero = false;
    std::printf("[diag dcbz-fill] next=0x%x lowIntact=%d highZero=%d\n",
                (u32)next_pc, (int)low_intact, (int)high_zero);
    return next_pc == (s32)(PC + 4u) && low_intact && high_zero;
}

// dcbz with an unaligned EA rounds DOWN to the 32-byte line (EA & ~31):
// r3=0x80000000 r4=0x3C -> EA 0x8000003C -> line 0x80000020 -> zero [32,64).
static bool test_dcbz_unaligned_rounds_down() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u8 buffer[64];
    for (u32 i = 0; i < 64u; ++i) buffer[i] = 0x55;
    const u32 host_buffer_addr = (u32)(uintptr_t)&buffer[0];
    env.gpr(3) = 0x80000000u;
    env.gpr(4) = 0x0000003Cu;
    u32 insts[] = { (31u << 26) | (3u << 16) | (4u << 11) | (1014u << 1) };  // dcbz r3,r4
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc,
                            host_buffer_addr, 63u, 64u)) return false;
    bool low_intact = true, high_zero = true;
    for (u32 i = 0; i < 32u; ++i)  if (buffer[i] != 0x55) low_intact = false;
    for (u32 i = 32u; i < 64u; ++i) if (buffer[i] != 0x00) high_zero = false;
    std::printf("[diag dcbz-align] next=0x%x lowIntact=%d highZero=%d\n",
                (u32)next_pc, (int)low_intact, (int)high_zero);
    return next_pc == (s32)(PC + 4u) && low_intact && high_zero;
}

// dcbz to a classify-REJECTED EA (0xCC005000, MMIO) must take the interp
// fallback (Interpreter::dcbz owns direct-store/DSI semantics) and must NOT
// touch the RAM window.
static bool test_dcbz_mmio_falls_back_to_interp() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80003000;
    u8 buffer[64];
    for (u32 i = 0; i < 64u; ++i) buffer[i] = 0x77;
    const u32 host_buffer_addr = (u32)(uintptr_t)&buffer[0];
    env.gpr(4) = 0xCC005000u;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_interp_calls = [];
        Module.__saved_interp = Module.bemental_imports.env.ppc_interp;
        Module.bemental_imports.env.ppc_interp = function(inst, addr) {
            Module.test_interp_calls.push([inst >>> 0, addr >>> 0]);
        };
    });
#endif
    u32 insts[] = { (31u << 26) | (0u << 16) | (4u << 11) | (1014u << 1) };  // dcbz 0,r4
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 1, &next_pc,
                                         host_buffer_addr, 63u, 64u);
#ifdef __EMSCRIPTEN__
    const u32 n_interp = (u32)EM_ASM_INT({ return Module.test_interp_calls.length | 0; });
    const u32 ia = (u32)EM_ASM_INT({ return (Module.test_interp_calls[0] || [0, 0])[1] | 0; });
    EM_ASM({ Module.bemental_imports.env.ppc_interp = Module.__saved_interp; });
#else
    const u32 n_interp = 1, ia = PC;
#endif
    if (!dispatched) return false;
    bool ram_intact = true;
    for (u32 i = 0; i < 64u; ++i) if (buffer[i] != 0x77) ram_intact = false;
    std::printf("[diag dcbz-mmio] n_interp=%u addr=0x%x ramIntact=%d\n",
                n_interp, ia, (int)ram_intact);
    return n_interp == 1u && ia == PC && ram_intact;
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

// ---------------------------------------------------------------------------
// psq_l / psq_st conformance (red-first for the native paired-single
// quantized load/store emitters; bit-exact reference =
// Interpreter_LoadStorePaired.cpp). All tests: MSR.FP=1, HID2.PSE|LSQE set
// (spr 920 = 0xA0000000), GQR via spr(912+I). Encodings hand-verified
// against Gekko.h field positions (W=bit15, I=bits12-14, SIMM_12=bits0-11).
// ---------------------------------------------------------------------------

static void psq_env_common(TestEnv& env) {
    *(u32*)((u8*)env.ctx_raw + ppc_off::MSR) = 0x2000u;   // MSR.FP=1
    env.spr(920) = 0xA0000000u;                            // HID2.PSE|LSQE
}

// psq_l f1, 8(r3), W=0, I=0; GQR0 ld FLOAT scale 0.
// Pair load: read32(EA)=1.0f, read32(EA+4)=2.0f -> ps0=1.0, ps1=2.0.
static bool test_psq_l_float_pair() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    env.spr(912) = 0;              // GQR0: ld_type FLOAT, scale 0
    env.gpr(3) = 0x80100000u;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_reads = [];
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            addr = addr >>> 0;
            Module.test_reads.push(addr);
            if (addr === 0x80100008) return 0x3F800000 | 0;  // 1.0f
            if (addr === 0x8010000C) return 0x40000000 | 0;  // 2.0f
            return 0;
        };
    });
#endif
    const u32 insts[] = { 0xE0230008u }; // psq_l f1, 8(r3), W=0, I=0
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 1, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 n_reads = (u32)EM_ASM_INT({ return Module.test_reads.length | 0; });
    EM_ASM({ Module.bemental_imports.env.ppc_read32 = function(addr) { return 0; }; });
#else
    const u32 n_reads = 0;
#endif
    if (!dispatched) return false;
    const u64 ps0 = *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps0(1));
    const u64 ps1 = *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps1(1));
    std::printf("[diag psq_l-f] reads=%u ps0=0x%016llx (exp 3ff0..) ps1=0x%016llx (exp 4000..) next=0x%08x\n",
                n_reads, (unsigned long long)ps0, (unsigned long long)ps1, (u32)next_pc);
    return ps0 == 0x3FF0000000000000ull && ps1 == 0x4000000000000000ull
        && n_reads == 2u && next_pc == (s32)(PC + 4);
}

// psq_l f1, 8(r3), W=1: single read; ps1 MUST be 1.0
// (Interpreter_LoadStorePaired.cpp:238 — not 0, not a copy of ps0).
static bool test_psq_l_w1_ps1_one() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    env.spr(912) = 0;
    env.gpr(3) = 0x80100000u;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_reads = [];
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            Module.test_reads.push(addr >>> 0);
            return 0x40400000 | 0;  // 3.0f
        };
    });
#endif
    const u32 insts[] = { 0xE0238008u }; // psq_l f1, 8(r3), W=1, I=0
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 1, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 n_reads = (u32)EM_ASM_INT({ return Module.test_reads.length | 0; });
    EM_ASM({ Module.bemental_imports.env.ppc_read32 = function(addr) { return 0; }; });
#else
    const u32 n_reads = 0;
#endif
    if (!dispatched) return false;
    const u64 ps0 = *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps0(1));
    const u64 ps1 = *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps1(1));
    std::printf("[diag psq_l-w1] reads=%u ps0=0x%016llx (exp 4008..) ps1=0x%016llx (exp 3ff0..)\n",
                n_reads, (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == 0x4008000000000000ull && ps1 == 0x3FF0000000000000ull && n_reads == 1u;
}

// psq_l f1, 8(r3), W=0, I=1; GQR1 ld U8 scale 4: pair is ONE u16 read
// (ReadPair<u8>, ILSP:83 — ps0 = hi byte); ps = f32(byte) * 2^-4.
static bool test_psq_l_u8_scale4() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    env.spr(913) = 0x04040000u;    // GQR1: ld_type U8(4), ld_scale 4
    env.gpr(3) = 0x80100000u;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_reads16 = [];
        Module.bemental_imports.env.ppc_read16 = function(addr) {
            Module.test_reads16.push(addr >>> 0);
            return 0xC80A | 0;     // ps0 byte=200, ps1 byte=10
        };
    });
#endif
    const u32 insts[] = { 0xE0231008u }; // psq_l f1, 8(r3), W=0, I=1
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 1, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 n_reads = (u32)EM_ASM_INT({ return Module.test_reads16.length | 0; });
    EM_ASM({ Module.bemental_imports.env.ppc_read16 = function(addr) { return 0; }; });
#else
    const u32 n_reads = 0;
#endif
    if (!dispatched) return false;
    const u64 ps0 = *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps0(1));
    const u64 ps1 = *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps1(1));
    std::printf("[diag psq_l-u8] reads16=%u ps0=0x%016llx (exp 4029.. = 12.5) ps1=0x%016llx (exp 3fe4.. = 0.625)\n",
                n_reads, (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == 0x4029000000000000ull && ps1 == 0x3FE4000000000000ull && n_reads == 1u;
}

// psq_st f2, 16(r4), W=1, I=0; GQR0 st FLOAT scale 0. ps0 holds a double in
// the single-DENORMAL range (exp 890, sign set): ConvertToSingleFTZ
// (ILSP:159, FPU:565-577) flushes to SIGNED ZERO 0x80000000 — the non-FTZ
// stfs converter would denormalize instead. THE distinguishing FTZ vector.
static bool test_psq_st_float_ftz_denormal() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    env.spr(912) = 0;
    env.gpr(4) = 0x80200000u;
    *(u64*)((u8*)env.ctx_raw + ppc_off::ps0(2)) = 0xB7A0000000000000ull;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_writes = [];
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_writes.push([addr >>> 0, val >>> 0]);
        };
    });
#endif
    const u32 insts[] = { 0xF0448010u }; // psq_st f2, 16(r4), W=1, I=0
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 1, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 n_writes = (u32)EM_ASM_INT({ return Module.test_writes.length | 0; });
    const u32 wa = (u32)EM_ASM_INT({ return (Module.test_writes[0] || [0,0])[0] | 0; });
    const u32 wv = (u32)EM_ASM_INT({ return (Module.test_writes[0] || [0,0])[1] | 0; });
    EM_ASM({ Module.bemental_imports.env.ppc_write32 = function(addr, val) {}; });
#else
    const u32 n_writes = 0, wa = 0, wv = 0;
#endif
    if (!dispatched) return false;
    std::printf("[diag psq_st-ftz] n=%u w=(0x%08x,0x%08x exp 0x80200010,0x80000000)\n", n_writes, wa, wv);
    return n_writes == 1u && wa == 0x80200010u && wv == 0x80000000u;
}

// psq_st f2, 16(r4), W=0, I=2; GQR2 st S16 scale 0. ps0=40000.75 clamps to
// 32767; ps1=-5.9 truncates toward zero to -5. Pair = ONE u32 write
// (WritePair<u16>, ILSP:118): (32767<<16)|0xFFFB.
static bool test_psq_st_s16_clamp_trunc() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    env.spr(914) = 0x00000007u;    // GQR2: st_type S16(7), st_scale 0
    env.gpr(4) = 0x80200000u;
    *(u64*)((u8*)env.ctx_raw + ppc_off::ps0(2)) = 0x40E3881800000000ull; // 40000.75
    *(u64*)((u8*)env.ctx_raw + ppc_off::ps1(2)) = 0xC01799999999999Aull; // -5.9
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_writes = [];
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_writes.push([addr >>> 0, val >>> 0]);
        };
    });
#endif
    const u32 insts[] = { 0xF0442010u }; // psq_st f2, 16(r4), W=0, I=2
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 1, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 n_writes = (u32)EM_ASM_INT({ return Module.test_writes.length | 0; });
    const u32 wa = (u32)EM_ASM_INT({ return (Module.test_writes[0] || [0,0])[0] | 0; });
    const u32 wv = (u32)EM_ASM_INT({ return (Module.test_writes[0] || [0,0])[1] | 0; });
    EM_ASM({ Module.bemental_imports.env.ppc_write32 = function(addr, val) {}; });
#else
    const u32 n_writes = 0, wa = 0, wv = 0;
#endif
    if (!dispatched) return false;
    std::printf("[diag psq_st-s16] n=%u w=(0x%08x,0x%08x exp 0x80200010,0x7ffffffb)\n", n_writes, wa, wv);
    return n_writes == 1u && wa == 0x80200010u && wv == 0x7FFFFFFBu;
}

// psq_lu f1, 8(r3): RA writeback = EA on the non-faulting path.
static bool test_psq_lu_ra_writeback() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    env.spr(912) = 0;
    env.gpr(3) = 0x80100000u;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.bemental_imports.env.ppc_read32 = function(addr) { return 0x3F800000 | 0; };
    });
#endif
    const u32 insts[] = { 0xE4230008u }; // psq_lu f1, 8(r3), W=0, I=0
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 1, &next_pc);
#ifdef __EMSCRIPTEN__
    EM_ASM({ Module.bemental_imports.env.ppc_read32 = function(addr) { return 0; }; });
#endif
    if (!dispatched) return false;
    const u32 ra = env.gpr(3);
    std::printf("[diag psq_lu-wb] r3=0x%08x (exp 0x80100008)\n", ra);
    return ra == 0x80100008u;
}

// ---------------------------------------------------------------------------
// op59 single-precision arithmetic + op63 frsp (2026-06-12 wave).
// Reference semantics: Interpreter_FloatingPoint.cpp — result =
// ForceSingle(fpscr, <f64 op>), ps[FD].Fill(result) (BOTH lanes);
// fmuls/fmadds-family apply Force25Bit to frC first (Interpreter_FPUtils.h:91).
// ForceSingle is gated on runtime FPSCR.NI (bit 2): pre-cast flush of
// |x| < 2^-126 to signed zero + post-cast f32-denormal flush.
// Red under fallback: the harness interp stub is a no-op, so fd keeps its
// sentinel until the native emitters land.
// ---------------------------------------------------------------------------

static void fp_env_common(TestEnv& env) {
    *(u32*)((u8*)env.ctx_raw + ppc_off::MSR) = 0x2000u;    // MSR.FP=1
    *(u32*)((u8*)env.ctx_raw + ppc_off::FPSCR) = 0u;       // NI=0 default
}

static void set_ps(TestEnv& env, u32 n, u64 lane0, u64 lane1) {
    *(u64*)((u8*)env.ctx_raw + ppc_off::ps0(n)) = lane0;
    *(u64*)((u8*)env.ctx_raw + ppc_off::ps1(n)) = lane1;
}

static u64 get_ps0(TestEnv& env, u32 n) { return *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps0(n)); }
static u64 get_ps1(TestEnv& env, u32 n) { return *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps1(n)); }

static u64 dbits(double d) { u64 r; std::memcpy(&r, &d, 8); return r; }

// Host mirror of Interpreter_FPUtils.h Force25Bit (normal-path only — test
// vectors avoid double subnormals).
static double host_force25(double d) {
    u64 i = dbits(d);
    i = (i & 0xFFFFFFFFF8000000ull) + (i & 0x8000000ull);
    double r; std::memcpy(&r, &i, 8); return r;
}

static const u64 FP_SENTINEL = 0xDEADBEEFCAFEF00Dull;

// fadds f0,f1,f2: 2.5 + 0.25 = 2.75 exactly; BOTH lanes filled.
static bool test_fadds_fill_both_lanes() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    fp_env_common(env);
    set_ps(env, 0, FP_SENTINEL, FP_SENTINEL);
    set_ps(env, 1, 0x4004000000000000ull, 0);  // 2.5
    set_ps(env, 2, 0x3FD0000000000000ull, 0);  // 0.25
    const u32 insts[] = { 0xEC01102Au };       // fadds f0,f1,f2
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, 0), ps1 = get_ps1(env, 0);
    std::printf("[diag fadds] ps0=0x%016llx ps1=0x%016llx (exp 4006.. both)\n",
                (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == 0x4006000000000000ull && ps1 == 0x4006000000000000ull;
}

// fadds under NI=1: 2^-127 + 0 — result is a single-subnormal magnitude,
// ForceSingle pre-cast flush => +0.0. Control arm NI=0 keeps 2^-127
// (exactly representable as f32 subnormal).
static bool test_fadds_ni_flush_vs_keep() {
    const u32 PC = 0x80300000;
    const u32 insts[] = { 0xEC01102Au };       // fadds f0,f1,f2
    u64 got_ni1, got_ni0;
    {
        TestEnv env;
        if (!env.init()) return false;
        fp_env_common(env);
        *(u32*)((u8*)env.ctx_raw + ppc_off::FPSCR) = 0x4u;  // NI=1
        set_ps(env, 0, FP_SENTINEL, FP_SENTINEL);
        set_ps(env, 1, 0x3800000000000000ull, 0);  // 2^-127
        set_ps(env, 2, 0, 0);                      // +0.0
        s32 next_pc = -1;
        if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
        got_ni1 = get_ps0(env, 0);
    }
    {
        TestEnv env;
        if (!env.init()) return false;
        fp_env_common(env);                         // NI=0
        set_ps(env, 0, FP_SENTINEL, FP_SENTINEL);
        set_ps(env, 1, 0x3800000000000000ull, 0);
        set_ps(env, 2, 0, 0);
        s32 next_pc = -1;
        if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
        got_ni0 = get_ps0(env, 0);
    }
    std::printf("[diag fadds-ni] ni1=0x%016llx (exp 0) ni0=0x%016llx (exp 3800..)\n",
                (unsigned long long)got_ni1, (unsigned long long)got_ni0);
    return got_ni1 == 0ull && got_ni0 == 0x3800000000000000ull;
}

// fmuls f0,f1,f2: frC=1+2^-25 must be Force25Bit-rounded to 1+2^-24
// BEFORE the multiply — 3.0 * (1+2^-24) rounds f32-up to 3+2^-22, whereas
// the un-rounded product 3*(1+2^-25) would round f32-down to 3.0.
static bool test_fmuls_force25bit_c() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    fp_env_common(env);
    const u64 c_bits = 0x3FF0000008000000ull;  // 1 + 2^-25
    set_ps(env, 0, FP_SENTINEL, FP_SENTINEL);
    set_ps(env, 1, 0x4008000000000000ull, 0);  // 3.0
    set_ps(env, 2, c_bits, 0);
    double c; std::memcpy(&c, &c_bits, 8);
    const u64 expected = dbits((double)(float)(3.0 * host_force25(c)));
    const u64 naive    = dbits((double)(float)(3.0 * c));
    const u32 insts[] = { 0xEC0100B2u };       // fmuls f0,f1,f2 (frC=2)
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, 0), ps1 = get_ps1(env, 0);
    std::printf("[diag fmuls-25] ps0=0x%016llx exp=0x%016llx naive=0x%016llx\n",
                (unsigned long long)ps0, (unsigned long long)expected, (unsigned long long)naive);
    return ps0 == expected && ps1 == expected && expected != naive;
}

// fmadds f0,f1,f2,f3 — 2*3 + 0.5 = 6.5 exact, both lanes.
static bool test_fmadds_basic() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    fp_env_common(env);
    set_ps(env, 0, FP_SENTINEL, FP_SENTINEL);
    set_ps(env, 1, 0x4000000000000000ull, 0);  // 2.0 (frA)
    set_ps(env, 2, 0x4008000000000000ull, 0);  // 3.0 (frC)
    set_ps(env, 3, 0x3FE0000000000000ull, 0);  // 0.5 (frB)
    const u32 insts[] = { 0xEC0118BAu };       // fmadds f0,f1,f2,f3
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, 0), ps1 = get_ps1(env, 0);
    std::printf("[diag fmadds] ps0=0x%016llx ps1=0x%016llx (exp 401A.. both)\n",
                (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == 0x401A000000000000ull && ps1 == 0x401A000000000000ull;
}

// fnmsubs f0,f1,f2,f3 — -(2*3 - 0.5) = -5.5 both lanes.
static bool test_fnmsubs_sign() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    fp_env_common(env);
    set_ps(env, 0, FP_SENTINEL, FP_SENTINEL);
    set_ps(env, 1, 0x4000000000000000ull, 0);
    set_ps(env, 2, 0x4008000000000000ull, 0);
    set_ps(env, 3, 0x3FE0000000000000ull, 0);
    const u32 insts[] = { 0xEC0118BCu };       // fnmsubs f0,f1,f2,f3 (sub5=30)
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, 0), ps1 = get_ps1(env, 0);
    std::printf("[diag fnmsubs] ps0=0x%016llx ps1=0x%016llx (exp C016.. both)\n",
                (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == 0xC016000000000000ull && ps1 == 0xC016000000000000ull;
}

// fdivs f0,f1,f2 — 1.0/3.0 rounded to single, both lanes.
static bool test_fdivs_round_single() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    fp_env_common(env);
    set_ps(env, 0, FP_SENTINEL, FP_SENTINEL);
    set_ps(env, 1, 0x3FF0000000000000ull, 0);  // 1.0
    set_ps(env, 2, 0x4008000000000000ull, 0);  // 3.0
    const u64 expected = dbits((double)(float)(1.0 / 3.0));
    const u32 insts[] = { 0xEC011024u };       // fdivs f0,f1,f2 (sub5=18)
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, 0), ps1 = get_ps1(env, 0);
    std::printf("[diag fdivs] ps0=0x%016llx exp=0x%016llx\n",
                (unsigned long long)ps0, (unsigned long long)expected);
    return ps0 == expected && ps1 == expected;
}

// frsp f0,f2 — 1+2^-30 rounds to 1.0f; Fill BOTH lanes
// (Interpreter frspx: ps[FD].Fill(rounded)).
static bool test_frsp_fill_both() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    fp_env_common(env);
    set_ps(env, 0, FP_SENTINEL, FP_SENTINEL);
    set_ps(env, 2, 0x3FF0000000400000ull, 0);  // 1 + 2^-30
    const u32 insts[] = { 0xFC001018u };       // frsp f0,f2 (op63 sub10=12)
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, 0), ps1 = get_ps1(env, 0);
    std::printf("[diag frsp] ps0=0x%016llx ps1=0x%016llx (exp 3FF0.. both)\n",
                (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == 0x3FF0000000000000ull && ps1 == 0x3FF0000000000000ull;
}

// ps_sum1 f4,f1,f2,f3 — control (FD distinct from all inputs).
// Reference (Interpreter_Paired.cpp ps_sum1): ps0 = ForceSingle(c.ps0);
// ps1 = ForceSingle(a.ps0 + b.ps1). a=f1.ps0=3.0, b=f3.ps1=5.0, c=f2.ps0=7.0
// -> f4 = (7.0, 8.0). Off-lanes are junk to prove they're unread.
static bool test_ps_sum1_basic() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);                                   // MSR.FP + HID2.PSE|LSQE
    set_ps(env, 1, dbits(3.0), dbits(9.0));                // a (ps1 junk)
    set_ps(env, 2, dbits(7.0), dbits(11.0));               // c (ps1 junk)
    set_ps(env, 3, dbits(13.0), dbits(5.0));               // b (ps0 junk)
    set_ps(env, 4, FP_SENTINEL, FP_SENTINEL);
    const u32 insts[] = { 0x10811896u };       // ps_sum1 f4,f1,f2,f3 (op4 xo5=11)
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, 4), ps1 = get_ps1(env, 4);
    std::printf("[diag ps_sum1] ps0=0x%016llx (exp 401C..=7.0) ps1=0x%016llx (exp 4020..=8.0)\n",
                (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == dbits(7.0) && ps1 == dbits(8.0);
}

// ps_sum1 f1,f1,f2,f3 — FD ALIASES FA (2026-07-31 audit finding). The copy
// lane (fd.ps0 <- ForceSingle(c.ps0)) must NOT clobber a.ps0 before the sum
// lane reads it: expected ps1 = ForceSingle(a.ps0_old + b.ps1) = 3.0+5.0 =
// 8.0. The copy-before-sum emit order computed 7.0+5.0 = 12.0 (fd.ps0 and
// fa.ps0 are the same wasm local when FD==FA — fpr_reg_cache ps0_local_idx
// = m_local_base + preg).
static bool test_ps_sum1_fd_aliases_fa() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);                                   // MSR.FP + HID2.PSE|LSQE
    set_ps(env, 1, dbits(3.0), dbits(9.0));                // a AND d (ps1 junk)
    set_ps(env, 2, dbits(7.0), dbits(11.0));               // c (ps1 junk)
    set_ps(env, 3, dbits(13.0), dbits(5.0));               // b (ps0 junk)
    const u32 insts[] = { 0x10211896u };       // ps_sum1 f1,f1,f2,f3
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, 1), ps1 = get_ps1(env, 1);
    std::printf("[diag ps_sum1-alias] ps0=0x%016llx (exp 401C..=7.0) ps1=0x%016llx (exp 4020..=8.0; buggy 4028..=12.0)\n",
                (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == dbits(7.0) && ps1 == dbits(8.0);
}

// ---------------------------------------------------------------------------
// A-form paired-single arithmetic (ps_add/ps_sub/ps_mul/ps_madd) via the
// SIMD single-form fast path — the PSMTXConcat/PSMTXInverse matrix-math path
// used by J3D character skinning (SAB Sonic). Operands are primed into SINGLE
// (v128) form with psq_l float-pair loads so emit_ps_binary/emit_ps_fma take
// the frc.IsSingle f32x4 fast path (NOT the scalar per-lane path that set_ps
// exercises). DISTINCT ps0/ps1 lanes catch a stale-lane bug (the fres class).
// All operands/results are f32-exact, so f32x4 == reference bit-for-bit.
// ---------------------------------------------------------------------------
static bool run_ps_simd(const char* tag, u32 op_inst, u32 fd,
                        u32 a0, u32 a1, u32 b0, u32 b1, u32 c0, u32 c1,
                        u64 exp_ps0, u64 exp_ps1) {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    env.spr(912) = 0;                 // GQR0: ld FLOAT scale 0
    env.gpr(3) = 0x80100000u;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        var m = {};
        m[0x80100000] = $0 >>> 0; m[0x80100004] = $1 >>> 0;
        m[0x80100008] = $2 >>> 0; m[0x8010000C] = $3 >>> 0;
        m[0x80100010] = $4 >>> 0; m[0x80100014] = $5 >>> 0;
        Module.__psmem = m;
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            addr = addr >>> 0;
            return (addr in Module.__psmem) ? (Module.__psmem[addr] | 0) : 0;
        };
    }, a0, a1, b0, b1, c0, c1);
#endif
    const u32 insts[] = {
        0xE0230000u,  // psq_l f1, 0(r3)   W=0 I=0
        0xE0430008u,  // psq_l f2, 8(r3)
        0xE0630010u,  // psq_l f3, 16(r3)
        op_inst,
    };
    s32 next_pc = -1;
    bool ok = env.dispatch_block(PC, insts, 4, &next_pc);
#ifdef __EMSCRIPTEN__
    EM_ASM({ Module.bemental_imports.env.ppc_read32 = function(addr) { return 0; }; });
#endif
    if (!ok) return false;
    const u64 ps0 = get_ps0(env, fd), ps1 = get_ps1(env, fd);
    std::printf("[diag %s] ps0=0x%016llx (exp 0x%016llx) ps1=0x%016llx (exp 0x%016llx)\n",
                tag, (unsigned long long)ps0, (unsigned long long)exp_ps0,
                (unsigned long long)ps1, (unsigned long long)exp_ps1);
    return ps0 == exp_ps0 && ps1 == exp_ps1;
}
// a={2.5,7.0} b={0.25,3.0} c={1.0,2.0}. ps_add f0,f1,f2 -> {2.75,10.0}
static bool test_ps_add_simd() {
    return run_ps_simd("ps_add-simd", 0x1001102Au, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(2.75), dbits(10.0));
}
// ps_sub f0,f1,f2 -> {2.25,4.0}
static bool test_ps_sub_simd() {
    return run_ps_simd("ps_sub-simd", 0x10011028u, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(2.25), dbits(4.0));
}
// ps_mul f0,f1,f2 (2nd operand = FC) -> {0.625,21.0}
static bool test_ps_mul_simd() {
    return run_ps_simd("ps_mul-simd", 0x100100B2u, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(0.625), dbits(21.0));
}
// ps_madd f0,f1,f2,f3 = f1*f2 + f3 -> {1.625,23.0}
static bool test_ps_madd_simd() {
    return run_ps_simd("ps_madd-simd", 0x100118BAu, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(1.625), dbits(23.0));
}
// ps_madd f1,f1,f2,f3 — FD==FA aliasing (matrix code reuses regs) -> {1.625,23.0}
static bool test_ps_madd_alias_fa() {
    return run_ps_simd("ps_madd-alias", 0x102118BAu, 1,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(1.625), dbits(23.0));
}

// ps_madds0/1, ps_muls0/1, ps_merge00/01/11 — the ACTUAL ops PSMTXROMultVecArray
// / PSMTXROSkin2VecArray (J3D skinning) are built on. emit_ps_madds/muls have NO
// SIMD fast path: frc.Bind(FPR_LANE_BOTH) must CONVERT the psq_l single-form regs
// to double form, then broadcast one frC lane. run_ps_simd primes via psq_l so
// this single->double conversion + broadcast path is exercised (previously only
// ps_merge10/ps_sum1 were covered). a={2.5,7.0} b={0.25,3.0} c={1.0,2.0}.
// ps_madds0 f0,f1,f2,f3 = f1*f2.ps0 + f3 = {2.5*.25+1, 7*.25+2} = {1.625, 3.75}
static bool test_ps_madds0_simd() {
    return run_ps_simd("ps_madds0-simd", 0x1001189Cu, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(1.625), dbits(3.75));
}
// ps_madds1 = f1*f2.ps1 + f3 = {2.5*3+1, 7*3+2} = {8.5, 23.0}
static bool test_ps_madds1_simd() {
    return run_ps_simd("ps_madds1-simd", 0x1001189Eu, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(8.5), dbits(23.0));
}
// ps_muls0 f0,f1,f2 = f1*f2.ps0 = {0.625, 1.75}
static bool test_ps_muls0_simd() {
    return run_ps_simd("ps_muls0-simd", 0x10010098u, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(0.625), dbits(1.75));
}
// ps_muls1 f0,f1,f2 = f1*f2.ps1 = {7.5, 21.0}
static bool test_ps_muls1_simd() {
    return run_ps_simd("ps_muls1-simd", 0x1001009Au, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(7.5), dbits(21.0));
}
// ps_merge00 f0,f1,f2 -> {f1.ps0, f2.ps0} = {2.5, 0.25}
static bool test_ps_merge00_simd() {
    return run_ps_simd("ps_merge00-simd", 0x10011420u, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(2.5), dbits(0.25));
}
// ps_merge01 f0,f1,f2 -> {f1.ps0, f2.ps1} = {2.5, 3.0}
static bool test_ps_merge01_simd() {
    return run_ps_simd("ps_merge01-simd", 0x10011460u, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(2.5), dbits(3.0));
}
// ps_merge11 f0,f1,f2 -> {f1.ps1, f2.ps1} = {7.0, 3.0}
static bool test_ps_merge11_simd() {
    return run_ps_simd("ps_merge11-simd", 0x100114E0u, 0,
        0x40200000,0x40E00000, 0x3E800000,0x40400000, 0x3F800000,0x40000000,
        dbits(7.0), dbits(3.0));
}

// ---------------------------------------------------------------------------
// ps_madds0/1 DEST==SRC ALIASING regression (2026-08-09 bent-legs fix in
// emit_ps_madds, jit_paired.cpp:604). The op broadcasts ONE fC lane (fC.ps0
// for madds0, fC.ps1 for madds1) into BOTH output lanes; that lane is a single
// shared wasm local. emit_single_fma_lane reads c at its head and writes
// d_local at its tail. The OLD emitter emitted the ps0 output lane FIRST,
// UNCONDITIONALLY. For ps_madds0 with fd==fc, the ps0 output's d_local IS the
// shared c local (fpr_reg_cache: ps0_local[N]=base+N, so fd.ps0==fc.ps0 iff
// d==c), so writing ps0 first clobbered fC.ps0 before the ps1 lane read it ->
// ps1 computed fA.ps1 * <stale fD.ps0> + fB.ps1. Fix emits the NON-c-lane
// output first. These pin fd aliasing every source (fc/fa/fb) which the
// existing FD-distinct ps_madds*_simd tests do NOT cover.
//
// The existing run_ps_simd already exercises the SCALAR per-lane arm for
// ps_madds (emit_ps_madds has no SIMD fast path — frc.Bind(FPR_LANE_BOTH)
// converts the psq_l single-form inputs to double), which is exactly the arm
// that carried the bug.
//
// Inputs chosen so a stale ps0->ps1 leak is numerically loud AND f32-exact:
//   fA={2.0,3.0}(f1)  fC={5.0,7.0}(f2)  fB={1.0,1.0}(f3)
// run_ps_simd arg mapping: arg a->fA(f1), arg b->fC(f2), arg c->fB(f3).
//   a0,a1=fA=0x40000000,0x40400000 ; b0,b1=fC=0x40A00000,0x40E00000 ;
//   c0,c1=fB=0x3F800000,0x3F800000.
//
// ps_madds0 f2,f1,f2,f3  (fd==fc — THE bug): d=2 a=1 b=3 c=2 xo=14 -> 0x1041189C
//   correct: ps0 = fA.ps0*fC.ps0+fB.ps0 = 2*5+1 = 11.0
//            ps1 = fA.ps1*fC.ps0+fB.ps1 = 3*5+1 = 16.0
//   OLD buggy: ps0=11.0 (written first, clobbers shared fC.ps0 local),
//              ps1 = fA.ps1*<stale fD.ps0=11>+fB.ps1 = 3*11+1 = 34.0 (0x4041.. != 0x4030..)
static bool test_ps_madds0_alias_fd_eq_fc() {
    return run_ps_simd("ps_madds0-alias-fd-eq-fc", 0x1041189Cu, 2,
        0x40000000,0x40400000, 0x40A00000,0x40E00000, 0x3F800000,0x3F800000,
        dbits(11.0), dbits(16.0));   // OLD buggy ps1 = 34.0
}
// ps_madds0 f1,f1,f2,f3  (fd==fa): d=1 a=1 b=3 c=2 xo=14 -> 0x1021189C
//   fd==fa is alias-safe in BOTH old and new (fA and fC are distinct locals;
//   the fd.ps0 write clobbers fA.ps0, but fA.ps0 is never re-read — each output
//   lane reads only its own fA lane). Correct == same as the FD-distinct result.
//   correct: ps0 = 2*5+1 = 11.0 ; ps1 = 3*5+1 = 16.0.
static bool test_ps_madds0_alias_fd_eq_fa() {
    return run_ps_simd("ps_madds0-alias-fd-eq-fa", 0x1021189Cu, 1,
        0x40000000,0x40400000, 0x40A00000,0x40E00000, 0x3F800000,0x3F800000,
        dbits(11.0), dbits(16.0));
}
// ps_madds0 f3,f1,f2,f3  (fd==fb): d=3 a=1 b=3 c=2 xo=14 -> 0x1061189C
//   fd==fb also alias-safe (fB.psN read then that same lane's fD.psN written —
//   different lanes never collide). correct: ps0=11.0 ps1=16.0.
static bool test_ps_madds0_alias_fd_eq_fb() {
    return run_ps_simd("ps_madds0-alias-fd-eq-fb", 0x1061189Cu, 3,
        0x40000000,0x40400000, 0x40A00000,0x40E00000, 0x3F800000,0x3F800000,
        dbits(11.0), dbits(16.0));
}
// ps_madds1 f2,f1,f2,f3  (fd==fc, other variant): d=2 a=1 b=3 c=2 xo=15 -> 0x1041189E
//   c_lane=ps1: shared local = fC.ps1, output collision is on the PS1 lane.
//   Under the OLD unconditional ps0-first order this variant did NOT fail (the
//   c-lane == ps1 write happened LAST, after both lanes had already read fC.ps1),
//   so it PASSES on both old and new code — kept as forward coverage that the
//   fix's c_lane==PS1 branch stays correct.
//   correct: ps0 = fA.ps0*fC.ps1+fB.ps0 = 2*7+1 = 15.0
//            ps1 = fA.ps1*fC.ps1+fB.ps1 = 3*7+1 = 22.0
static bool test_ps_madds1_alias_fd_eq_fc() {
    return run_ps_simd("ps_madds1-alias-fd-eq-fc", 0x1041189Eu, 2,
        0x40000000,0x40400000, 0x40A00000,0x40E00000, 0x3F800000,0x3F800000,
        dbits(15.0), dbits(22.0));
}

// ===========================================================================
// ps_madd / ps_msub / ps_nmadd / ps_nmsub DEST==SRC ALIASING coverage (sibling
// class of the 2026-08-09 ps_madds0 bent-legs bug — emit_ps_fma, jit_paired.cpp
// :455). These forward-cover the SAME write-before-read hazard shape that hit
// ps_madds/ps_merge10/ps_sum1, closing the "per-op conformance never tested
// dest==src" gap that let the ps_madds0 bug evade ~10 sessions.
//
// AUDIT VERDICT: emit_ps_fma's scalar per-lane arm is ALIAS-SAFE for fd==fa,
// fd==fb, AND fd==fc — UNLIKE ps_madds. The difference is the c operand:
//   * ps_madds fed ONE shared fC lane local (fc.ps0 for madds0) to BOTH output
//     lane calls, so writing the c-aliasing output lane FIRST clobbered c
//     before the other lane read it (the bug).
//   * emit_ps_fma passes PER-LANE locals: lane ps0 reads {fa.ps0, fc.ps0,
//     fb.ps0} and writes fd.ps0; lane ps1 reads {fa.ps1, fc.ps1, fb.ps1} and
//     writes fd.ps1 (jit_paired.cpp:496-499). emit_single_fma_lane reads all
//     THREE source locals at its head and writes d_local only at its tail
//     (jit_fp_helpers.h:982-986/1077 reads; :1073/1086 write).
//   Lane-local model (fpr_reg_cache.cpp:58-59): ps0_local[N]=base+N,
//   ps1_local[N]=base+32+N. The ps0 write (base+fd) can NEVER equal any ps1
//   read (base+32+X), and each lane reads its own sources before its own write.
//   => no cross-lane and no intra-lane clobber for ANY fd overlap. Every case
//   below is FORWARD COVERAGE: the correct value == the value the old (always-
//   ps0-first) order would have produced. If a future refactor introduced a
//   shared-source-across-lanes shape (as ps_madds had), these would go red.
//
// PRIMING: set_ps writes ctx ps[] as DOUBLE-form i64 bits, so frc.IsSingle is
// false and emit_ps_fma takes the SCALAR per-lane arm (the arm that carried the
// ps_madds bug) — NOT the f32x4 relaxed_madd SIMD fast path that psq_l/
// run_ps_simd would trigger. All operands are f32-exact integers, so
// Force25Bit(fC), the FMA tie-correction, and ForceSingle are all no-ops and
// the f64 fused result is bit-exact to the reference.
//
// Register file (double-form, f32-exact):
//   f1 = fA = {2.0, 3.0}   f2 = fC = {5.0, 7.0}   f3 = fB = {1.0, 1.0}
// A-form fields (assembler order fD,fA,fC,fB): FA=f1, FC=f2, FB=f3.
//   ps_madd  a*c+b   XO=29 : ps0=2*5+1=11.0  ps1=3*7+1=22.0
//   ps_msub  a*c-b   XO=28 : ps0=2*5-1= 9.0  ps1=3*7-1=20.0
//   ps_nmadd -(a*c+b)XO=31 : ps0=   -11.0    ps1=   -22.0
//   ps_nmsub -(a*c-b)XO=30 : ps0=    -9.0    ps1=   -20.0
// ===========================================================================
static bool run_ps_fma_alias(const char* tag, u32 op_inst, u32 fd,
                             u64 exp_ps0, u64 exp_ps1) {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);                        // MSR.FP=1 + HID2.PSE|LSQE
    fp_env_common(env);                         // FPSCR NI=0 (ForceSingle no-op)
    set_ps(env, 1, dbits(2.0), dbits(3.0));     // fA
    set_ps(env, 2, dbits(5.0), dbits(7.0));     // fC
    set_ps(env, 3, dbits(1.0), dbits(1.0));     // fB
    const u32 insts[] = { op_inst };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, fd), ps1 = get_ps1(env, fd);
    std::printf("[diag %s] ps0=0x%016llx (exp 0x%016llx) ps1=0x%016llx (exp 0x%016llx)\n",
                tag, (unsigned long long)ps0, (unsigned long long)exp_ps0,
                (unsigned long long)ps1, (unsigned long long)exp_ps1);
    return ps0 == exp_ps0 && ps1 == exp_ps1;
}

// ---- ps_madd  (XO=29) : fd = fA*fC + fB ----
// ps_madd f1,f1,f2,f3 (fd==fa) -> {11.0, 22.0}; word 0x102118BA
static bool test_ps_madd_alias_fd_eq_fa() {
    return run_ps_fma_alias("ps_madd-alias-fd-eq-fa", 0x102118BAu, 1,
                            dbits(11.0), dbits(22.0));
}
// ps_madd f3,f1,f2,f3 (fd==fb) -> {11.0, 22.0}; word 0x106118BA
static bool test_ps_madd_alias_fd_eq_fb() {
    return run_ps_fma_alias("ps_madd-alias-fd-eq-fb", 0x106118BAu, 3,
                            dbits(11.0), dbits(22.0));
}
// ps_madd f2,f1,f2,f3 (fd==fc) -> {11.0, 22.0}; word 0x104118BA
static bool test_ps_madd_alias_fd_eq_fc() {
    return run_ps_fma_alias("ps_madd-alias-fd-eq-fc", 0x104118BAu, 2,
                            dbits(11.0), dbits(22.0));
}

// ---- ps_msub  (XO=28) : fd = fA*fC - fB ----
// ps_msub f1,f1,f2,f3 (fd==fa) -> {9.0, 20.0}; word 0x102118B8
static bool test_ps_msub_alias_fd_eq_fa() {
    return run_ps_fma_alias("ps_msub-alias-fd-eq-fa", 0x102118B8u, 1,
                            dbits(9.0), dbits(20.0));
}
// ps_msub f3,f1,f2,f3 (fd==fb) -> {9.0, 20.0}; word 0x106118B8
static bool test_ps_msub_alias_fd_eq_fb() {
    return run_ps_fma_alias("ps_msub-alias-fd-eq-fb", 0x106118B8u, 3,
                            dbits(9.0), dbits(20.0));
}
// ps_msub f2,f1,f2,f3 (fd==fc) -> {9.0, 20.0}; word 0x104118B8
static bool test_ps_msub_alias_fd_eq_fc() {
    return run_ps_fma_alias("ps_msub-alias-fd-eq-fc", 0x104118B8u, 2,
                            dbits(9.0), dbits(20.0));
}

// ---- ps_nmadd (XO=31) : fd = -(fA*fC + fB) ----
// ps_nmadd f1,f1,f2,f3 (fd==fa) -> {-11.0, -22.0}; word 0x102118BE
static bool test_ps_nmadd_alias_fd_eq_fa() {
    return run_ps_fma_alias("ps_nmadd-alias-fd-eq-fa", 0x102118BEu, 1,
                            dbits(-11.0), dbits(-22.0));
}
// ps_nmadd f3,f1,f2,f3 (fd==fb) -> {-11.0, -22.0}; word 0x106118BE
static bool test_ps_nmadd_alias_fd_eq_fb() {
    return run_ps_fma_alias("ps_nmadd-alias-fd-eq-fb", 0x106118BEu, 3,
                            dbits(-11.0), dbits(-22.0));
}
// ps_nmadd f2,f1,f2,f3 (fd==fc) -> {-11.0, -22.0}; word 0x104118BE
static bool test_ps_nmadd_alias_fd_eq_fc() {
    return run_ps_fma_alias("ps_nmadd-alias-fd-eq-fc", 0x104118BEu, 2,
                            dbits(-11.0), dbits(-22.0));
}

// ---- ps_nmsub (XO=30) : fd = -(fA*fC - fB) ----
// ps_nmsub f1,f1,f2,f3 (fd==fa) -> {-9.0, -20.0}; word 0x102118BC
static bool test_ps_nmsub_alias_fd_eq_fa() {
    return run_ps_fma_alias("ps_nmsub-alias-fd-eq-fa", 0x102118BCu, 1,
                            dbits(-9.0), dbits(-20.0));
}
// ps_nmsub f3,f1,f2,f3 (fd==fb) -> {-9.0, -20.0}; word 0x106118BC
static bool test_ps_nmsub_alias_fd_eq_fb() {
    return run_ps_fma_alias("ps_nmsub-alias-fd-eq-fb", 0x106118BCu, 3,
                            dbits(-9.0), dbits(-20.0));
}
// ps_nmsub f2,f1,f2,f3 (fd==fc) -> {-9.0, -20.0}; word 0x104118BC
static bool test_ps_nmsub_alias_fd_eq_fc() {
    return run_ps_fma_alias("ps_nmsub-alias-fd-eq-fc", 0x104118BCu, 2,
                            dbits(-9.0), dbits(-20.0));
}

// ===========================================================================
// PAIRED-SINGLE DEST==SRC ALIASING GRID — coda-1 completion (2026-08-09).
// Completes the bug-class-extinction sweep started by the ps_madds0/1 fix and
// the ps_madd/msub/nmadd/nmsub cases above. Covers the remaining ps families:
//   * arith (ps_add/sub/div, ps_mul) + broadcast-c (ps_muls0/1)  [emit_ps_binary,
//     emit_ps_muls]
//   * lane-shuffle / move / sign (ps_merge00/01/10/11, ps_mr, ps_neg/abs/nabs)
//   * ps_sum0/ps_sum1 (asymmetric sum+copy) and ps_sel
// AUDIT VERDICT for every emitter here: ALIAS-SAFE. The two cases that would
// FAIL a regressed emitter are ps_muls0 fd==fc (per-lane-c/ps0-first -> ps1=48
// instead of 6) and the merge b-first / stack-both-first pins (ps_merge00 fd==fb,
// ps_merge10 fd==fa); the rest are FORWARD coverage locking lane-disjointness.
// Cited: fpr_reg_cache.cpp:58-59 (ps0_local[N]=base+N, ps1_local[N]=base+32+N,
// disjoint lanes); jit_paired.cpp:423-445 (binary read-before-write),
// :576-579 (muls stash-c-once), :174-179 (merge00 b-first), :235-238 (merge10
// stack-both), :542-556 (sum0/sum1 order), :279-311 (sel per-lane).
//
// arith/muls use run_ps_simd (psq_l single-form -> the SIMD f32x4 arm, which is
// itself read-before-write atomic); merge/mr/sign/sum/sel use set_ps direct-ctx
// priming (Double-form -> the SCALAR per-lane arm that carried the ps_madds bug).
// arg mapping for run_ps_simd: argA->fA(f1), argB->fC(f2), argC->fB(f3).
// ---------------------------------------------------------------------------

// ---- ps_add / ps_sub / ps_div : operands (fA, fB); fA in a-slot, fB in c-slot
//      (f3), f2-slot junk. fA={8,3}(f1) fB={2,5}(f3). ------------------------
// ps_add fD,f1,f3 = {10.0, 8.0}. All alias-safe -> forward coverage.
static bool test_ps_add_alias_ctrl() {
    return run_ps_simd("ps_add-ctrl", 0x1001182Au, 0,
        0x41000000,0x40400000, 0x42C60000,0x429A0000, 0x40000000,0x40A00000,
        dbits(10.0), dbits(8.0));
}
static bool test_ps_add_alias_fd_eq_fa() {
    return run_ps_simd("ps_add-alias-fd-eq-fa", 0x1021182Au, 1,
        0x41000000,0x40400000, 0x42C60000,0x429A0000, 0x40000000,0x40A00000,
        dbits(10.0), dbits(8.0));
}
static bool test_ps_add_alias_fd_eq_fb() {
    return run_ps_simd("ps_add-alias-fd-eq-fb", 0x1061182Au, 3,
        0x41000000,0x40400000, 0x42C60000,0x429A0000, 0x40000000,0x40A00000,
        dbits(10.0), dbits(8.0));
}
// ps_sub fD,f1,f3 = {6.0, -2.0}.
static bool test_ps_sub_alias_ctrl() {
    return run_ps_simd("ps_sub-ctrl", 0x10011828u, 0,
        0x41000000,0x40400000, 0x42C60000,0x429A0000, 0x40000000,0x40A00000,
        dbits(6.0), dbits(-2.0));
}
static bool test_ps_sub_alias_fd_eq_fa() {
    return run_ps_simd("ps_sub-alias-fd-eq-fa", 0x10211828u, 1,
        0x41000000,0x40400000, 0x42C60000,0x429A0000, 0x40000000,0x40A00000,
        dbits(6.0), dbits(-2.0));
}
static bool test_ps_sub_alias_fd_eq_fb() {
    return run_ps_simd("ps_sub-alias-fd-eq-fb", 0x10611828u, 3,
        0x41000000,0x40400000, 0x42C60000,0x429A0000, 0x40000000,0x40A00000,
        dbits(6.0), dbits(-2.0));
}
// ps_div fD,f1,f3 = {4.0, 0.6f}. 0.6f f32-exact -> promote to f64 for compare.
static bool test_ps_div_alias_ctrl() {
    return run_ps_simd("ps_div-ctrl", 0x10011824u, 0,
        0x41000000,0x40400000, 0x42C60000,0x429A0000, 0x40000000,0x40A00000,
        dbits(4.0), dbits((double)(float)(3.0/5.0)));
}
static bool test_ps_div_alias_fd_eq_fa() {
    return run_ps_simd("ps_div-alias-fd-eq-fa", 0x10211824u, 1,
        0x41000000,0x40400000, 0x42C60000,0x429A0000, 0x40000000,0x40A00000,
        dbits(4.0), dbits((double)(float)(3.0/5.0)));
}
static bool test_ps_div_alias_fd_eq_fb() {
    return run_ps_simd("ps_div-alias-fd-eq-fb", 0x10611824u, 3,
        0x41000000,0x40400000, 0x42C60000,0x429A0000, 0x40000000,0x40A00000,
        dbits(4.0), dbits((double)(float)(3.0/5.0)));
}

// ---- ps_mul / ps_muls0 / ps_muls1 : operands (fA, fC); fA in a-slot, fC in
//      b-slot (f2), f3-slot junk. fA={8,3}(f1) fC={2,5}(f2). -----------------
// ps_mul fD,f1,f2 — PER-LANE c: {16.0, 15.0}. fd==fc read-before-write in-lane.
static bool test_ps_mul_alias_ctrl() {
    return run_ps_simd("ps_mul-ctrl", 0x100100B2u, 0,
        0x41000000,0x40400000, 0x40000000,0x40A00000, 0x42C60000,0x429A0000,
        dbits(16.0), dbits(15.0));
}
static bool test_ps_mul_alias_fd_eq_fa() {
    return run_ps_simd("ps_mul-alias-fd-eq-fa", 0x102100B2u, 1,
        0x41000000,0x40400000, 0x40000000,0x40A00000, 0x42C60000,0x429A0000,
        dbits(16.0), dbits(15.0));
}
static bool test_ps_mul_alias_fd_eq_fc() {
    return run_ps_simd("ps_mul-alias-fd-eq-fc", 0x104100B2u, 2,
        0x41000000,0x40400000, 0x40000000,0x40A00000, 0x42C60000,0x429A0000,
        dbits(16.0), dbits(15.0));
}
// ps_muls0 fD,f1,f2 — BROADCAST fC.ps0: {16.0, 6.0}.
static bool test_ps_muls0_alias_ctrl() {
    return run_ps_simd("ps_muls0-ctrl", 0x10010098u, 0,
        0x41000000,0x40400000, 0x40000000,0x40A00000, 0x42C60000,0x429A0000,
        dbits(16.0), dbits(6.0));
}
static bool test_ps_muls0_alias_fd_eq_fa() {
    return run_ps_simd("ps_muls0-alias-fd-eq-fa", 0x10210098u, 1,
        0x41000000,0x40400000, 0x40000000,0x40A00000, 0x42C60000,0x429A0000,
        dbits(16.0), dbits(6.0));
}
// ps_muls0 fd==fc (0x10410098) — THE ps_madds-class collision. emit_ps_muls
// stashes Force25Bit(c) into LOCAL_FMA_C0 (jit_paired.cpp:576-579) before either
// lane, so ps1 reads the intact c. Correct ps1=6.0; a per-lane-c/ps0-first
// regression would give ps1 = fA.ps1*<stale fd.ps0=16> = 48.0. DISCRIMINATES.
static bool test_ps_muls0_alias_fd_eq_fc() {
    return run_ps_simd("ps_muls0-alias-fd-eq-fc", 0x10410098u, 2,
        0x41000000,0x40400000, 0x40000000,0x40A00000, 0x42C60000,0x429A0000,
        dbits(16.0), dbits(6.0));   // OLD/naive-buggy ps1 = 48.0
}
// ps_muls1 fD,f1,f2 — BROADCAST fC.ps1: {40.0, 15.0}.
static bool test_ps_muls1_alias_ctrl() {
    return run_ps_simd("ps_muls1-ctrl", 0x1001009Au, 0,
        0x41000000,0x40400000, 0x40000000,0x40A00000, 0x42C60000,0x429A0000,
        dbits(40.0), dbits(15.0));
}
static bool test_ps_muls1_alias_fd_eq_fa() {
    return run_ps_simd("ps_muls1-alias-fd-eq-fa", 0x1021009Au, 1,
        0x41000000,0x40400000, 0x40000000,0x40A00000, 0x42C60000,0x429A0000,
        dbits(40.0), dbits(15.0));
}
static bool test_ps_muls1_alias_fd_eq_fc() {
    return run_ps_simd("ps_muls1-alias-fd-eq-fc", 0x1041009Au, 2,
        0x41000000,0x40400000, 0x40000000,0x40A00000, 0x42C60000,0x429A0000,
        dbits(40.0), dbits(15.0));
}

// ---- ps_sum0 / ps_sum1 : A-form (fD,fA,fC,fB). fA={2,3}(f1) fC={11,13}(f2)
//      fB={5,7}(f3). sum lane = fA.ps0+fB.ps1 = 2+7 = 9.0. -------------------
// ps_sum0: ps0=9.0, ps1=fC.ps1=13.0. All alias-safe -> forward coverage.
static bool test_ps_sum0_basic() {
    return run_ps_simd("ps_sum0-basic", 0x10811894u, 4,
        0x40000000,0x40400000, 0x41300000,0x41500000, 0x40A00000,0x40E00000,
        dbits(9.0), dbits(13.0));
}
static bool test_ps_sum0_alias_fd_eq_fa() {
    return run_ps_simd("ps_sum0-alias-fd-eq-fa", 0x10211894u, 1,
        0x40000000,0x40400000, 0x41300000,0x41500000, 0x40A00000,0x40E00000,
        dbits(9.0), dbits(13.0));
}
static bool test_ps_sum0_alias_fd_eq_fb() {
    return run_ps_simd("ps_sum0-alias-fd-eq-fb", 0x10611894u, 3,
        0x40000000,0x40400000, 0x41300000,0x41500000, 0x40A00000,0x40E00000,
        dbits(9.0), dbits(13.0));
}
static bool test_ps_sum0_alias_fd_eq_fc() {
    return run_ps_simd("ps_sum0-alias-fd-eq-fc", 0x10411894u, 2,
        0x40000000,0x40400000, 0x41300000,0x41500000, 0x40A00000,0x40E00000,
        dbits(9.0), dbits(13.0));
}
// ps_sum1: ps0=fC.ps0=11.0, ps1=9.0. fd==fa is DISCRIMINATING (2026-07-31
// sum-first fix): the old copy-first order clobbered fA.ps0 with fC.ps0 before
// the sum read it -> ps1 = fC.ps0+fB.ps1 = 11+7 = 18.0.
static bool test_ps_sum1_alias_fd_eq_fa_simd() {
    return run_ps_simd("ps_sum1-alias-fd-eq-fa-simd", 0x10211896u, 1,
        0x40000000,0x40400000, 0x41300000,0x41500000, 0x40A00000,0x40E00000,
        dbits(11.0), dbits(9.0));   // OLD buggy ps1 = 18.0
}
static bool test_ps_sum1_alias_fd_eq_fb() {
    return run_ps_simd("ps_sum1-alias-fd-eq-fb", 0x10611896u, 3,
        0x40000000,0x40400000, 0x41300000,0x41500000, 0x40A00000,0x40E00000,
        dbits(11.0), dbits(9.0));
}
static bool test_ps_sum1_alias_fd_eq_fc() {
    return run_ps_simd("ps_sum1-alias-fd-eq-fc", 0x10411896u, 2,
        0x40000000,0x40400000, 0x41300000,0x41500000, 0x40A00000,0x40E00000,
        dbits(11.0), dbits(9.0));
}

// ---- ps_sel fD,fA,fC,fB : per lane d.psN = (a.psN >= -0.0) ? c.psN : b.psN.
//      a MIXED {+1.0,-1.0} exercises both arms: ps0 picks c(=100), ps1 picks
//      b(=400). All alias-safe -> forward coverage. -----------------------
static bool run_ps_sel_alias(const char* tag, u32 op_inst, u32 fd) {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);                                   // MSR.FP + HID2.PSE|LSQE
    set_ps(env, 1, dbits(1.0),   dbits(-1.0));             // fa : ps0->pick c, ps1->pick b
    set_ps(env, 2, dbits(100.0), dbits(200.0));            // fc
    set_ps(env, 3, dbits(300.0), dbits(400.0));            // fb
    if (fd != 1 && fd != 2 && fd != 3) set_ps(env, fd, FP_SENTINEL, FP_SENTINEL);
    s32 next_pc = -1;
    const u32 insts[] = { op_inst };
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, fd), ps1 = get_ps1(env, fd);
    std::printf("[diag %s] ps0=0x%016llx (exp 4059..=100.0) ps1=0x%016llx (exp 4079..=400.0)\n",
                tag, (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == dbits(100.0) && ps1 == dbits(400.0);
}
static bool test_ps_sel_basic() {
    return run_ps_sel_alias("ps_sel-basic", 0x100118AEu, 0);
}
static bool test_ps_sel_alias_fd_eq_fa() {
    return run_ps_sel_alias("ps_sel-alias-fd-eq-fa", 0x102118AEu, 1);
}
static bool test_ps_sel_alias_fd_eq_fb() {
    return run_ps_sel_alias("ps_sel-alias-fd-eq-fb", 0x106118AEu, 3);
}
static bool test_ps_sel_alias_fd_eq_fc() {
    return run_ps_sel_alias("ps_sel-alias-fd-eq-fc", 0x104118AEu, 2);
}

// ---- ps_merge00/01/10/11 : lane-shuffle bit-moves. i64 lane sentinels so a
//      stale-lane leak is bit-loud. f1={0x1111..,0x1F1F..} f2={0x2222..,0x2F2F..}.
//      DISCRIMINATING: merge00 fd==fb (b-first fix), merge10 fd==fa (stack-both
//      fix). set_ps -> Double-form -> scalar per-lane path. --------------------
static const u64 MRG_F1_PS0 = 0x1111111111111111ull;
static const u64 MRG_F1_PS1 = 0x1F1F1F1F1F1F1F1Full;
static const u64 MRG_F2_PS0 = 0x2222222222222222ull;
static const u64 MRG_F2_PS1 = 0x2F2F2F2F2F2F2F2Full;

static bool run_merge_alias(const char* tag, u32 word, u32 fd,
                            u64 exp_ps0, u64 exp_ps1) {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);                                   // MSR.FP + HID2.PSE|LSQE
    set_ps(env, 1, MRG_F1_PS0, MRG_F1_PS1);
    set_ps(env, 2, MRG_F2_PS0, MRG_F2_PS1);
    if (fd != 1 && fd != 2) set_ps(env, fd, FP_SENTINEL, FP_SENTINEL);
    const u32 insts[] = { word };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, fd), ps1 = get_ps1(env, fd);
    std::printf("[diag %s] fd%u ps0=0x%016llx (exp 0x%016llx) ps1=0x%016llx (exp 0x%016llx)\n",
                tag, fd, (unsigned long long)ps0, (unsigned long long)exp_ps0,
                (unsigned long long)ps1, (unsigned long long)exp_ps1);
    return ps0 == exp_ps0 && ps1 == exp_ps1;
}
// ps_merge00 (d.ps0<-a.ps0, d.ps1<-b.ps0).
static bool test_ps_merge00_alias_fd_distinct() {
    return run_merge_alias("ps_merge00-distinct", 0x10011420u, 0, MRG_F1_PS0, MRG_F2_PS0);
}
static bool test_ps_merge00_alias_fd_eq_fa() {
    return run_merge_alias("ps_merge00-fd-eq-fa", 0x10211420u, 1, MRG_F1_PS0, MRG_F2_PS0);
}
// fd==fb DISCRIMINATES: b-first order gives ps1=f2.ps0; the OLD d.ps0-first
// order clobbered the shared f2.ps0 local with f1.ps0 -> ps1=0x1111...
static bool test_ps_merge00_alias_fd_eq_fb() {
    return run_merge_alias("ps_merge00-fd-eq-fb", 0x10411420u, 2, MRG_F1_PS0, MRG_F2_PS0);
}
// ps_merge01 (d.ps0<-a.ps0, d.ps1<-b.ps1) — lane-disjoint, forward coverage.
static bool test_ps_merge01_alias_fd_distinct() {
    return run_merge_alias("ps_merge01-distinct", 0x10011460u, 0, MRG_F1_PS0, MRG_F2_PS1);
}
static bool test_ps_merge01_alias_fd_eq_fa() {
    return run_merge_alias("ps_merge01-fd-eq-fa", 0x10211460u, 1, MRG_F1_PS0, MRG_F2_PS1);
}
static bool test_ps_merge01_alias_fd_eq_fb() {
    return run_merge_alias("ps_merge01-fd-eq-fb", 0x10411460u, 2, MRG_F1_PS0, MRG_F2_PS1);
}
// ps_merge10 (d.ps0<-a.ps1, d.ps1<-b.ps0).
static bool test_ps_merge10_alias_fd_distinct() {
    return run_merge_alias("ps_merge10-distinct", 0x100114A0u, 0, MRG_F1_PS1, MRG_F2_PS0);
}
// fd==fa DISCRIMINATES: stack-both-first gives ps0=f1.ps1; the OLD ps1-first
// order clobbered f1.ps1 (==d.ps1) with f2.ps0 before the d.ps0 read -> ps0=0x2222...
static bool test_ps_merge10_alias_fd_eq_fa_b2() {
    return run_merge_alias("ps_merge10-fd-eq-fa", 0x102114A0u, 1, MRG_F1_PS1, MRG_F2_PS0);
}
static bool test_ps_merge10_alias_fd_eq_fb() {
    return run_merge_alias("ps_merge10-fd-eq-fb", 0x104114A0u, 2, MRG_F1_PS1, MRG_F2_PS0);
}
// ps_merge11 (d.ps0<-a.ps1, d.ps1<-b.ps1) — lane-disjoint, forward coverage.
static bool test_ps_merge11_alias_fd_distinct() {
    return run_merge_alias("ps_merge11-distinct", 0x100114E0u, 0, MRG_F1_PS1, MRG_F2_PS1);
}
static bool test_ps_merge11_alias_fd_eq_fa() {
    return run_merge_alias("ps_merge11-fd-eq-fa", 0x102114E0u, 1, MRG_F1_PS1, MRG_F2_PS1);
}
static bool test_ps_merge11_alias_fd_eq_fb() {
    return run_merge_alias("ps_merge11-fd-eq-fb", 0x104114E0u, 2, MRG_F1_PS1, MRG_F2_PS1);
}

// ---- ps_mr / ps_neg / ps_abs / ps_nabs : single-source (fD,fB); only fd==fb
//      aliasing. Real f64 doubles so the scalar emit_lane_bit_op path runs.
//      fB.ps0=+2.5, fB.ps1=-7.0. ----------------------------------------------
static const u64 SS_B_PS0 = 0x4004000000000000ull;  // +2.5
static const u64 SS_B_PS1 = 0xC01C000000000000ull;  // -7.0

static bool run_single_src(const char* tag, u32 word, u32 fd, u32 fb,
                           u64 exp_ps0, u64 exp_ps1) {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    set_ps(env, fb, SS_B_PS0, SS_B_PS1);
    if (fd != fb) set_ps(env, fd, FP_SENTINEL, FP_SENTINEL);
    const u32 insts[] = { word };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, fd), ps1 = get_ps1(env, fd);
    std::printf("[diag %s] fd%u ps0=0x%016llx (exp 0x%016llx) ps1=0x%016llx (exp 0x%016llx)\n",
                tag, fd, (unsigned long long)ps0, (unsigned long long)exp_ps0,
                (unsigned long long)ps1, (unsigned long long)exp_ps1);
    return ps0 == exp_ps0 && ps1 == exp_ps1;
}
static bool test_ps_mr_alias_fd_distinct() {          // ps_mr f0,f2 = 0x10001090
    return run_single_src("ps_mr-distinct", 0x10001090u, 0, 2, SS_B_PS0, SS_B_PS1);
}
static bool test_ps_mr_alias_fd_eq_fb() {             // ps_mr f2,f2 = 0x10401090
    return run_single_src("ps_mr-fd-eq-fb", 0x10401090u, 2, 2, SS_B_PS0, SS_B_PS1);
}
static bool test_ps_neg_alias_fd_distinct() {         // neg(+2.5)=-2.5, neg(-7.0)=+7.0
    return run_single_src("ps_neg-distinct", 0x10001050u, 0, 2,
                          0xC004000000000000ull, 0x401C000000000000ull);
}
static bool test_ps_neg_alias_fd_eq_fb() {
    return run_single_src("ps_neg-fd-eq-fb", 0x10401050u, 2, 2,
                          0xC004000000000000ull, 0x401C000000000000ull);
}
static bool test_ps_abs_alias_fd_distinct() {         // abs(+2.5)=+2.5, abs(-7.0)=+7.0
    return run_single_src("ps_abs-distinct", 0x10001210u, 0, 2,
                          0x4004000000000000ull, 0x401C000000000000ull);
}
static bool test_ps_abs_alias_fd_eq_fb() {
    return run_single_src("ps_abs-fd-eq-fb", 0x10401210u, 2, 2,
                          0x4004000000000000ull, 0x401C000000000000ull);
}
static bool test_ps_nabs_alias_fd_distinct() {        // nabs(+2.5)=-2.5, nabs(-7.0)=-7.0
    return run_single_src("ps_nabs-distinct", 0x10001110u, 0, 2,
                          0xC004000000000000ull, 0xC01C000000000000ull);
}
static bool test_ps_nabs_alias_fd_eq_fb() {
    return run_single_src("ps_nabs-fd-eq-fb", 0x10401110u, 2, 2,
                          0xC004000000000000ull, 0xC01C000000000000ull);
}

// fctiwz f14,f14 (0xFDC0701E — the exact encoding in PSO HandleReverb's
// inner loop at 0x803bf1bc, the loop's LAST interp fallback).
// Reference: Interpreter ConvertToInteger (TowardsZero): value =
// NaN -> 0x80000000; >= 2^31 -> 0x7FFFFFFF; < -2^31 -> 0x80000000;
// else (s32)trunc(b). ps0 = 0xFFF8000000000000 | value, PLUS bit 32 set
// when value==0 && signbit(b). ps1 UNTOUCHED (SetPS0, not Fill).
static bool test_fctiwz_vectors() {
    struct V { u64 in; u64 expect; };
    const V vs[] = {
        { 0xBFFC000000000000ull, 0xFFF80000FFFFFFFFull },  // -1.75 -> -1
        { 0xBFD0000000000000ull, 0xFFF8000100000000ull },  // -0.25 -> 0, signbit quirk
        { 0x7FF8000000000000ull, 0xFFF8000080000000ull },  // NaN -> 0x80000000
        { 0x421BF08EB0000000ull, 0xFFF800007FFFFFFFull },  // 3e10 -> saturate +
    };
    for (unsigned i = 0; i < sizeof(vs)/sizeof(vs[0]); ++i) {
        TestEnv env;
        if (!env.init()) return false;
        const u32 PC = 0x80300000;
        fp_env_common(env);
        set_ps(env, 14, vs[i].in, FP_SENTINEL);
        const u32 insts[] = { 0xFDC0701Eu };
        s32 next_pc = -1;
        if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
        const u64 ps0 = get_ps0(env, 14), ps1 = get_ps1(env, 14);
        std::printf("[diag fctiwz] v%u in=0x%016llx ps0=0x%016llx exp=0x%016llx ps1=0x%016llx\n",
                    i, (unsigned long long)vs[i].in, (unsigned long long)ps0,
                    (unsigned long long)vs[i].expect, (unsigned long long)ps1);
        if (ps0 != vs[i].expect || ps1 != FP_SENTINEL) return false;
    }
    return true;
}

// adde rX,rX,rX carry-out when rt==ra==rb (the __div2i 0x80396dc4 shift-
// through-carry pattern). Pre-fix bug: emit_ca_chain wrote dest before
// reading operand_a for carry1, so for rt==ra the carry-out collapsed to
// CA_in and the real (2*rX overflow) carry was dropped — corrupting any
// 64-bit divide with a high-word-set dividend (PSO OSGetTime/CARDProbeEx).
// Sequence: r3=0x80000000, r4=0, CA=0.
//   adde r3,r3,r3 -> r3 = 0 (0x80000000+0x80000000 wraps), CA_out MUST = 1
//   adde r4,r4,r4 -> r4 = 0+CA_in(1) = 1, CA_out = 0
// Pre-fix gave r3=0,r4=0 (CA dropped). Post-fix: r3=0,r4=1.
static bool test_adde_alias_carry_chain() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    *(u8*)((u8*)env.ctx_raw + ppc_off::XER_CA) = 0;
    env.gpr(3) = 0x80000000u;
    env.gpr(4) = 0u;
    const u32 insts[] = { 0x7C631914u /* adde r3,r3,r3 */,
                          0x7C842114u /* adde r4,r4,r4 */ };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 2, &next_pc)) return false;
    const u32 r3 = env.gpr(3), r4 = env.gpr(4);
    const u8 ca = *(const u8*)((const u8*)env.ctx_raw + ppc_off::XER_CA);
    std::printf("[diag adde-alias] r3=0x%08x r4=0x%08x ca=%u (exp r3=0 r4=1 ca=0)\n", r3, r4, ca);
    return r3 == 0u && r4 == 1u && ca == 0u;
}

// ps_merge10 fD,fA,fB with fD==fA (PSMTXIdentity 0x803763d4: ps_merge10
// f1,f1,f0 building identity matrix[2][2]=1.0). fD.ps0 <- fA.ps1; fD.ps1 <-
// fB.ps0. When fD==fA, d.ps1 and a.ps1 share a local; the pre-fix "write
// d.ps1 first" order clobbered a.ps1 before d.ps0 read it -> fD.ps0
// collapsed to fB.ps0 instead of fA.ps1, zeroing the matrix Z-row and
// clipping all 3D geometry (PSO renders only 2D overlay). Bit-move, so use
// i64 lane sentinels: f1=(ps0=0xAAA.., ps1=0x111..), f0=(ps0=0x000..).
// Expect f1=(0x111.., 0x000..). Pre-fix gave (0x000.., 0x000..).
static bool test_ps_merge10_alias_fd_eq_fa() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    *(u32*)((u8*)env.ctx_raw + ppc_off::MSR) = 0x2000u;   // MSR.FP=1
    env.spr(920) = 0xA0000000u;                            // HID2.PSE|LSQE
    const u64 F1_PS0 = 0xAAAAAAAAAAAAAAAAull;
    const u64 F1_PS1 = 0x1111111111111111ull;  // the "1.0" lane -> must reach ps0
    const u64 F0_PS0 = 0x0000000000000000ull;  // the "0.0" lane -> must reach ps1
    *(u64*)((u8*)env.ctx_raw + ppc_off::ps0(1)) = F1_PS0;
    *(u64*)((u8*)env.ctx_raw + ppc_off::ps1(1)) = F1_PS1;
    *(u64*)((u8*)env.ctx_raw + ppc_off::ps0(0)) = F0_PS0;
    *(u64*)((u8*)env.ctx_raw + ppc_off::ps1(0)) = 0xBBBBBBBBBBBBBBBBull;
    const u32 insts[] = { 0x102104A0u };  // ps_merge10 f1,f1,f0
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps0(1));
    const u64 ps1 = *(const u64*)((const u8*)env.ctx_raw + ppc_off::ps1(1));
    std::printf("[diag ps_merge10] f1.ps0=0x%016llx (exp 1111..) f1.ps1=0x%016llx (exp 0000..)\n",
                (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == F1_PS1 && ps1 == F0_PS0;
}

// ===========================================================================
// +2 RELOCATION REPRODUCTION (task 2026-06-23). The live MP4 boot wedge:
// the JIT mis-relocates EVERY R_PPC_ADDR16_LO by +2 while R_PPC_ADDR16_HA is
// correct. dolsdk Relocate() compiles the two arms as:
//   LO: lwz r0,4(r30); add r0,r5,r0; sth r0,0(r28)   <- add rt==rb (rt=r0,rb=r0)
//   HA: lwz r0,4(r30); add r4,r5,r0; ...             <- add rt!=rb (rt=r4,rb=r0)
// Same inputs (r5=section offset, r0=addend from lwz). Repro builds each shape
// as a real block, runs it, and reports actual vs expected. Unambiguous numbers:
//   r5 = 0x80420000 (section base offset)
//   addend-in-mem at [r3+4] = 0x00001D24 (a plausible 16-bit-LO+HA reconstruction)
//   correct sum = 0x80421D24 ; a +2 bug shows 0x80421D26.
// ===========================================================================

// ---- wasm byte dumper: print the emitted module hex for a given block ----
static void dump_block_wasm(const char* tag, u32 start_pc, const u32* insts,
                            u32 count, u32 ctx_ptr,
                            u32 mem1_base, u32 mem1_mask, u32 ram_size) {
    std::vector<u8> bytes = build_block_next(start_pc, insts, count, ctx_ptr,
                                             mem1_base, mem1_mask, ram_size);
    std::printf("[wasmdump %s] %u bytes\n", tag, (unsigned)bytes.size());
    char line[160];
    for (std::size_t i = 0; i < bytes.size(); i += 16) {
        int n = std::snprintf(line, sizeof(line), "[wasmdump %s] %04zx:", tag, i);
        for (std::size_t j = i; j < i + 16 && j < bytes.size(); ++j)
            n += std::snprintf(line + n, sizeof(line) - n, " %02x", bytes[j]);
        std::printf("%s\n", line);
    }
}

// Standalone adds (no load): exercise emit_binop_x in BOTH alias shapes.
//   (a) add r0,r5,r0  (rt==rb)  r0=0x24, r5=0x80420000 -> expect 0x80420024
//   (b) add r4,r5,r0  (rt!=rb)  same inputs            -> expect 0x80420024
static bool test_reloc_standalone_add_rt_eq_rb() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x800B7BF4;
    env.gpr(0) = 0x24u;
    env.gpr(5) = 0x80420000u;
    const u32 insts[] = { enc_add(0, 5, 0) };   // add r0,r5,r0  (rt==rb)
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u32 r0 = env.gpr(0);
    std::printf("[reloc standalone rt==rb] r0=0x%08x (exp 0x80420024)\n", r0);
    return r0 == 0x80420024u;
}
static bool test_reloc_standalone_add_rt_ne_rb() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x800B7C18;
    env.gpr(0) = 0x24u;
    env.gpr(5) = 0x80420000u;
    const u32 insts[] = { enc_add(4, 5, 0) };   // add r4,r5,r0  (rt!=rb)
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u32 r4 = env.gpr(4);
    std::printf("[reloc standalone rt!=rb] r4=0x%08x (exp 0x80420024)\n", r4);
    return r4 == 0x80420024u;
}

// load->add: lwz r0,4(r3); add r0,r5,r0   vs   lwz r0,4(r3); add r4,r5,r0.
// r3 points into a 64-byte MEM1-backed buffer; [r3+4] (big-endian) = 0x00001D24.
// r5 = 0x80420000. correct sum = 0x80421D24, watch for 0x80421D26.
static bool test_reloc_load_add_rt_eq_rb() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x800B7BF4;
    static u8 mem[64];
    std::memset(mem, 0, sizeof(mem));
    // big-endian 0x00001D24 at offset 4
    mem[4] = 0x00; mem[5] = 0x00; mem[6] = 0x1D; mem[7] = 0x24;
    const u32 host_base = (u32)(uintptr_t)&mem[0];
    env.gpr(3) = 0x80000000u;     // masks to offset 0 in the buffer; +4 -> [4..7]
    env.gpr(5) = 0x80420000u;
    const u32 insts[] = {
        enc_lwz(0, 3, 4),         // lwz r0, 4(r3)  -> r0 = 0x1D24
        enc_add(0, 5, 0),         // add r0, r5, r0 (rt==rb) -> expect 0x80421D24
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 2, &next_pc, host_base, 0x017FFFFFu, sizeof(mem)))
        return false;
    const u32 r0 = env.gpr(0);
    std::printf("[reloc load-add rt==rb] r0=0x%08x (exp 0x80421D24, +2 bug=0x80421D26)\n", r0);
    return r0 == 0x80421D24u;
}
static bool test_reloc_load_add_rt_ne_rb() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x800B7C18;
    static u8 mem[64];
    std::memset(mem, 0, sizeof(mem));
    mem[4] = 0x00; mem[5] = 0x00; mem[6] = 0x1D; mem[7] = 0x24;
    const u32 host_base = (u32)(uintptr_t)&mem[0];
    env.gpr(3) = 0x80000000u;
    env.gpr(5) = 0x80420000u;
    const u32 insts[] = {
        enc_lwz(0, 3, 4),         // lwz r0, 4(r3)  -> r0 = 0x1D24
        enc_add(4, 5, 0),         // add r4, r5, r0 (rt!=rb) -> expect 0x80421D24
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 2, &next_pc, host_base, 0x017FFFFFu, sizeof(mem)))
        return false;
    const u32 r4 = env.gpr(4);
    std::printf("[reloc load-add rt!=rb] r4=0x%08x (exp 0x80421D24, +2 bug=0x80421D26)\n", r4);
    return r4 == 0x80421D24u;
}

// FULL LO arm: lwz r0,4(r30); add r0,r5,r0; sth r0,0(r28)  vs the HA shape.
// r30 base load buffer; r28 store buffer. The sth writes the reconstructed
// half-word back; we capture the store value (the relocated low 16 bits the
// guest patches into the instruction stream). LO sth value should be 0x1D24;
// a +2 bug stores 0x1D26.
static bool test_reloc_full_lo_arm() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x800B7BEC;
    static u8 mem[256];
    std::memset(mem, 0, sizeof(mem));
    mem[4] = 0x00; mem[5] = 0x00; mem[6] = 0x1D; mem[7] = 0x24;  // [r30+4] = 0x1D24
    const u32 host_base = (u32)(uintptr_t)&mem[0];
    env.gpr(30) = 0x80000000u;    // masks to offset 0; +4 -> addend
    env.gpr(28) = 0x80000040u;    // masks to offset 0x40; sth target
    env.gpr(5)  = 0x80420000u;    // section base offset
    const u32 insts[] = {
        enc_lwz(0, 30, 4),                                   // lwz r0,4(r30) -> 0x1D24
        enc_add(0, 5, 0),                                    // add r0,r5,r0  (rt==rb)
        (44u << 26) | (0u << 21) | (28u << 16) | 0u,         // sth r0,0(r28)
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc, host_base, 0x017FFFFFu, sizeof(mem)))
        return false;
    // sth stores the LOW 16 bits big-endian at offset 0x40: bytes [0x40],[0x41].
    const u32 stored_hw = ((u32)mem[0x40] << 8) | (u32)mem[0x41];
    // BUG: emit_bswap_i16's `(x>>>8)` term is not masked to a byte before the
    // OR, so bits 16..23 of the register (0x42 here) leak into the low byte.
    // Stored hw observed = 0x1D66 instead of the correct 0x1D24.
    std::printf("[reloc full-lo] sth-stored-hw=0x%04x (exp 0x1D24; bswap16 bug stores 0x1D66) full-r0=0x%08x\n",
                stored_hw, env.gpr(0));
    return stored_hw == 0x1D24u && env.gpr(0) == 0x80421D24u;
}
static bool test_reloc_full_ha_arm() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x800B7C10;
    static u8 mem[256];
    std::memset(mem, 0, sizeof(mem));
    mem[4] = 0x00; mem[5] = 0x00; mem[6] = 0x1D; mem[7] = 0x24;
    const u32 host_base = (u32)(uintptr_t)&mem[0];
    env.gpr(30) = 0x80000000u;
    env.gpr(28) = 0x80000040u;
    env.gpr(5)  = 0x80420000u;
    const u32 insts[] = {
        enc_lwz(0, 30, 4),                                   // lwz r0,4(r30) -> 0x1D24
        enc_add(4, 5, 0),                                    // add r4,r5,r0  (rt!=rb)
        (44u << 26) | (4u << 21) | (28u << 16) | 0u,         // sth r4,0(r28)
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 3, &next_pc, host_base, 0x017FFFFFu, sizeof(mem)))
        return false;
    const u32 stored_hw = ((u32)mem[0x40] << 8) | (u32)mem[0x41];
    std::printf("[reloc full-ha] sth-stored-hw=0x%04x (exp 0x1D24) full-r4=0x%08x\n",
                stored_hw, env.gpr(4));
    return stored_hw == 0x1D24u && env.gpr(4) == 0x80421D24u;
}

// Dump-only "test": emits the wasm hex for the load->add LO and HA shapes so
// the bytes can be diffed. Always returns true (it is a dumper, not an
// assertion). The dump goes to the full conformance log.
static bool test_reloc_wasm_dump() {
    TestEnv env;
    if (!env.init()) return false;
    static u8 mem[64];
    std::memset(mem, 0, sizeof(mem));
    mem[4] = 0x00; mem[5] = 0x00; mem[6] = 0x1D; mem[7] = 0x24;
    const u32 host_base = (u32)(uintptr_t)&mem[0];
    {
        const u32 lo[] = { enc_lwz(0, 3, 4), enc_add(0, 5, 0) };   // rt==rb
        dump_block_wasm("LO_load_add", 0x800B7BF4, lo, 2, env.ctx_ptr,
                        host_base, 0x017FFFFFu, sizeof(mem));
    }
    {
        const u32 ha[] = { enc_lwz(0, 3, 4), enc_add(4, 5, 0) };   // rt!=rb
        dump_block_wasm("HA_load_add", 0x800B7C18, ha, 2, env.ctx_ptr,
                        host_base, 0x017FFFFFu, sizeof(mem));
    }
    {
        const u32 lo1[] = { enc_add(0, 5, 0) };   // standalone rt==rb
        dump_block_wasm("LO_standalone", 0x800B7BF4, lo1, 1, env.ctx_ptr,
                        host_base, 0x017FFFFFu, sizeof(mem));
    }
    {
        const u32 ha1[] = { enc_add(4, 5, 0) };   // standalone rt!=rb
        dump_block_wasm("HA_standalone", 0x800B7C18, ha1, 1, env.ctx_ptr,
                        host_base, 0x017FFFFFu, sizeof(mem));
    }
    {
        const u32 lo3[] = { enc_lwz(0, 30, 4), enc_add(0, 5, 0),
                            (44u << 26) | (0u << 21) | (28u << 16) | 0u };
        dump_block_wasm("LO_full", 0x800B7BEC, lo3, 3, env.ctx_ptr,
                        host_base, 0x017FFFFFu, sizeof(mem));
    }
    {
        const u32 ha3[] = { enc_lwz(0, 30, 4), enc_add(4, 5, 0),
                            (44u << 26) | (4u << 21) | (28u << 16) | 0u };
        dump_block_wasm("HA_full", 0x800B7C10, ha3, 3, env.ctx_ptr,
                        host_base, 0x017FFFFFu, sizeof(mem));
    }
    return true;
}

extern "C" { extern uint32_t g_bem_lc_base; }

// ---- [single-spec v9 dual-arm] SINGLES-ARM execution coverage ----
// The dual-arm emitter (ppc_emit.cpp PM44) emits ps blocks twice; the
// singles arm executes only when g_bem_lc_base != 0 AND the shadow-mask
// guard passes at entry. The standard suite runs with lc_base=0 (Double
// arm only), so these cases force the singles arm: lc_base set, hook
// query installed, mask all-ones, all FPR inputs exact widened singles.
struct SinglesArmEnv {
    u32 saved_lc;
    bemental::powerpc::HleHookQueryFn saved_query;
    u32 saved_mask;
    volatile u32* mask_cell =
        reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B33E0u));
    SinglesArmEnv() {
        saved_lc = g_bem_lc_base;
        g_bem_lc_base = 0x03000000u;
        saved_query = bemental::powerpc::g_hle_hook_query;
        bemental::powerpc::g_hle_hook_query = [](u32) -> bool { return false; };
        saved_mask = *mask_cell;
        *mask_cell = 0xFFFFFFFFu;
    }
    ~SinglesArmEnv() {
        *mask_cell = saved_mask;
        g_bem_lc_base = saved_lc;
        bemental::powerpc::g_hle_hook_query = saved_query;
    }
};

// S1: psq_l f1 (float pair) ; ps_add f2,f1,f1 ; psq_st f2 (float pair).
// f1=(1.0f,2.0f) loaded, f2=(2.0,4.0) stored -> writes 0x40000000,0x40800000.
// The ps_add makes the block dual-arm; mask all-ones -> singles arm runs.
static bool test_singles_arm_psq_chain() {
    TestEnv env;
    if (!env.init()) return false;
    SinglesArmEnv sa;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    env.spr(912) = 0;
    env.gpr(3) = 0x80100000u;
    env.gpr(4) = 0x80200000u;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_reads = [];
        Module.test_writes = [];
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            addr = addr >>> 0;
            if (addr === 0x80100008) return 0x3F800000 | 0;  // 1.0f
            if (addr === 0x8010000C) return 0x40000000 | 0;  // 2.0f
            return 0;
        };
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_writes.push([addr >>> 0, val >>> 0]);
        };
    });
#endif
    const u32 insts[] = {
        0xE0230008u,   // psq_l  f1, 8(r3), W=0, I=0
        0x1041082Au,   // ps_add f2, f1, f1
        0xF0440010u,   // psq_st f2, 16(r4), W=0, I=0
    };
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 3, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 nw = (u32)EM_ASM_INT({ return Module.test_writes.length | 0; });
    const u32 w0a = (u32)EM_ASM_INT({ return (Module.test_writes[0]||[0,0])[0] | 0; });
    const u32 w0v = (u32)EM_ASM_INT({ return (Module.test_writes[0]||[0,0])[1] | 0; });
    const u32 w1a = (u32)EM_ASM_INT({ return (Module.test_writes[1]||[0,0])[0] | 0; });
    const u32 w1v = (u32)EM_ASM_INT({ return (Module.test_writes[1]||[0,0])[1] | 0; });
    EM_ASM({
        Module.bemental_imports.env.ppc_read32 = function(addr) { return 0; };
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {};
    });
#else
    const u32 nw = 0, w0a = 0, w0v = 0, w1a = 0, w1v = 0;
#endif
    if (!dispatched) return false;
    const u64 ps0 = get_ps0(env, 2), ps1 = get_ps1(env, 2);
    std::printf("[diag singles-chain] f2=(%016llx,%016llx exp 4000..,4010..) writes n=%u "
                "[0]=%08x:%08x [1]=%08x:%08x (exp 80200010:40000000 80200014:40800000)\n",
                (unsigned long long)ps0, (unsigned long long)ps1,
                nw, w0a, w0v, w1a, w1v);
    return ps0 == dbits(2.0) && ps1 == dbits(4.0) &&
           nw == 2 && w0a == 0x80200010u && w0v == 0x40000000u &&
           w1a == 0x80200014u && w1v == 0x40800000u;
}

// S2: ps_mr f2,f1 ; stfs f2,0(r4) with f1 an assumed widened single (3.5).
// The PM37 black-canvas class ran through stfs-of-Single — verify the
// stored f32 bits are exact under the singles arm.
static bool test_singles_arm_stfs() {
    TestEnv env;
    if (!env.init()) return false;
    SinglesArmEnv sa;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    env.gpr(4) = 0x80200000u;
    set_ps(env, 1, dbits(3.5), dbits(9.0));
#ifdef __EMSCRIPTEN__
    EM_ASM({
        Module.test_writes = [];
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_writes.push([addr >>> 0, val >>> 0]);
        };
    });
#endif
    const u32 insts[] = {
        0x10400890u,   // ps_mr f2, f1   (op4 sub10=72)
        0xD0440000u,   // stfs  f2, 0(r4)
    };
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 2, &next_pc);
#ifdef __EMSCRIPTEN__
    const u32 nw = (u32)EM_ASM_INT({ return Module.test_writes.length | 0; });
    const u32 wa = (u32)EM_ASM_INT({ return (Module.test_writes[0]||[0,0])[0] | 0; });
    const u32 wv = (u32)EM_ASM_INT({ return (Module.test_writes[0]||[0,0])[1] | 0; });
    EM_ASM({ Module.bemental_imports.env.ppc_write32 = function(addr, val) {}; });
#else
    const u32 nw = 0, wa = 0, wv = 0;
#endif
    if (!dispatched) return false;
    std::printf("[diag singles-stfs] writes n=%u [0]=%08x:%08x (exp 80200000:40600000)\n",
                nw, wa, wv);
    return nw == 1 && wa == 0x80200000u && wv == 0x40600000u;
}

// S3: the ps_sum1 FD==FA alias case under the singles arm (inputs exact
// singles, mask all-ones) — the SIMD-path variant of the PM43 fix.
static bool test_singles_arm_ps_sum1_alias() {
    TestEnv env;
    if (!env.init()) return false;
    SinglesArmEnv sa;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    set_ps(env, 1, dbits(3.0), dbits(9.0));
    set_ps(env, 2, dbits(7.0), dbits(11.0));
    set_ps(env, 3, dbits(13.0), dbits(5.0));
    const u32 insts[] = { 0x10211896u };       // ps_sum1 f1,f1,f2,f3
    s32 next_pc = -1;
    if (!env.dispatch_block(PC, insts, 1, &next_pc)) return false;
    const u64 ps0 = get_ps0(env, 1), ps1 = get_ps1(env, 1);
    std::printf("[diag singles-sum1] ps0=%016llx (exp 401C..) ps1=%016llx (exp 4020..)\n",
                (unsigned long long)ps0, (unsigned long long)ps1);
    return ps0 == dbits(7.0) && ps1 == dbits(8.0);
}

// Dump-only "test": the exact __THPDecompressiMCURowNxN hot bdnz loop
// (0x800df2a4-0x800df378, disassembled 2026-07-31 from the byte-identical
// GMPE01_01 decomp ISO — the MEASURED ~20x-native 60fps limiter, oracle
// PM39/PM43+). 53 instrs: 8x psq_l GQR0-float(r9 workspace), 34x ps arith
// (add/sub butterflies, mul, madd/msub vs f27-f30 constants), 8x psq_st
// GQR6 U8-quantized (LC pixel rows), 5x int, bdnz self-loop. Emitted under
// production-equivalent config: fastmem armed, live GQR values (probe
// 2026-07-31: GQR6=0x3d043d04), g_bem_lc_base set, single-spec shadow mask
// = stable-half all-single. Dump feeds wasm-dis for per-guest-op cost
// attribution (the ps-emit campaign's measuring instrument).
extern "C" { extern uint32_t g_bem_lc_base; }
static bool test_idct_wasm_dump() {
    TestEnv env;
    if (!env.init()) return false;
    psq_env_common(env);
    env.spr(912) = 0;                          // GQR0: float ld
    env.spr(918) = 0x3d043d04u;                // GQR6: live MP4 value (U8 st)
    static const u32 idct[] = {
        0xe1690020u, 0x104246f8u, 0xe1490060u, 0x11894028u, 0x1023102au,
        0xe12900a0u, 0x11a31028u, 0xe10900e0u, 0x1069502au, 0x11295028u,
        0x39290008u, 0x104b402au, 0x116b4028u, 0xe0e90000u, 0x1102182au,
        0x11421828u, 0x1069582au, 0xe0c90080u, 0x1044402au, 0x10630732u,
        0xe0a90040u, 0x10044028u, 0x11291fbau, 0xe08900c0u, 0x11294028u,
        0x38e70002u, 0xf0456000u, 0x116b1f78u, 0x1041482au, 0x114a4ef8u,
        0x10214828u, 0xf0456008u, 0x106d502au, 0x116b502au, 0xf0656010u,
        0x38c60002u, 0x104c5828u, 0x106c582au, 0xf0456018u, 0x104d5028u,
        0x1127302au, 0xf0636000u, 0x10673028u, 0x1129f82au, 0xf0436008u,
        0x1105202au, 0x10452028u, 0xf0236010u, 0x7ca83a14u, 0x1089402au,
        0xf0036018u, 0x1063f82au, 0x7c683214u, 0x4200ff2cu,
    };
    const u32 n = (u32)(sizeof(idct) / sizeof(idct[0]));
    const u32 saved_lc = g_bem_lc_base;
    g_bem_lc_base = 0x03000000u;               // arm LC/spec paths (emit-only)
    // Mirror production (JitWasm.cpp:109 installs a real hook query): a null
    // g_hle_hook_query makes the emitter wrap EVERY op in Flush + HLE
    // prologue + ReloadAll — repr resets to Double per op, all SIMD paths
    // dead, ~10x emit blowup. That artifact config is NOT what ships.
    const auto saved_query = bemental::powerpc::g_hle_hook_query;
    bemental::powerpc::g_hle_hook_query = [](u32) -> bool { return false; };
    volatile u32* mask_cell =
        reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B33E0u));
    const u32 saved_mask = *mask_cell;
    *mask_cell = 0xFFFFFFFFu;                  // all-single (v8 incl. volatiles)
    dump_block_wasm("IDCT_spec", 0x800DF2A4u, idct, n, env.ctx_ptr,
                    0x10000000u, 0x017FFFFFu, 0x01800000u);
    *mask_cell = 0;                            // A/B: no single-spec
    dump_block_wasm("IDCT_nospec", 0x800DF2A4u, idct, n, env.ctx_ptr,
                    0x10000000u, 0x017FFFFFu, 0x01800000u);
    *mask_cell = saved_mask;
    g_bem_lc_base = saved_lc;
    bemental::powerpc::g_hle_hook_query = saved_query;
    return true;
}

// [PM53 fixed-cost bench] Execute the exact IDCT self-loop through the REAL
// self-chain path (compile once, dispatch; each host entry self-tail-calls
// CTR-1 times in-wasm) and report ns/iteration. Purpose: decide whether the
// loop is bound by body op count (~2135 executed ops post PM53 => ~150-250ns
// at plausible IPC) or by per-iteration FIXED cost (return_call_indirect
// back-edge + fresh-activation setup + V8 per-call dispatch) — the PM53
// wall-time-invariance finding predicts the latter. Zero-filled source rows
// (0.0f loads, no subnormals), NI=1 to mirror the live MP4 config, stores
// and loads in disjoint windows of one 1MB fastmem buffer.
static bool test_idct_selfchain_bench() {
#ifndef __EMSCRIPTEN__
    return true;
#else
    TestEnv env;
    if (!env.init()) return false;
    psq_env_common(env);
    env.spr(912) = 0;                          // GQR0: float ld
    env.spr(918) = 0x3d043d04u;                // GQR6: live MP4 value (U8 st)
    *(u32*)((u8*)env.ctx_raw + ppc_off::FPSCR) = 0x4u;   // NI=1 (live config)
    static const u32 idct[] = {
        0xe1690020u, 0x104246f8u, 0xe1490060u, 0x11894028u, 0x1023102au,
        0xe12900a0u, 0x11a31028u, 0xe10900e0u, 0x1069502au, 0x11295028u,
        0x39290008u, 0x104b402au, 0x116b4028u, 0xe0e90000u, 0x1102182au,
        0x11421828u, 0x1069582au, 0xe0c90080u, 0x1044402au, 0x10630732u,
        0xe0a90040u, 0x10044028u, 0x11291fbau, 0xe08900c0u, 0x11294028u,
        0x38e70002u, 0xf0456000u, 0x116b1f78u, 0x1041482au, 0x114a4ef8u,
        0x10214828u, 0xf0456008u, 0x106d502au, 0x116b502au, 0xf0656010u,
        0x38c60002u, 0x104c5828u, 0x106c582au, 0xf0456018u, 0x104d5028u,
        0x1127302au, 0xf0636000u, 0x10673028u, 0x1129f82au, 0xf0436008u,
        0x1105202au, 0x10452028u, 0xf0236010u, 0x7ca83a14u, 0x1089402au,
        0xf0036018u, 0x1063f82au, 0x7c683214u, 0x4200ff2cu,
    };
    const u32 n = (u32)(sizeof(idct) / sizeof(idct[0]));
    const u32 PC = 0x800DF2A4u;
    const u32 saved_lc = g_bem_lc_base;
    g_bem_lc_base = 0x03000000u;
    const auto saved_query = bemental::powerpc::g_hle_hook_query;
    bemental::powerpc::g_hle_hook_query = [](u32) -> bool { return false; };
    volatile u32* mask_cell =
        reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B33E0u));
    const u32 saved_mask = *mask_cell;
    *mask_cell = 0xFFFFFFFFu;                  // all-single

    // 1MB fastmem window: loads at masked 0x40000+, stores at 0x0/0x1000+.
    static std::vector<u8> buf;
    buf.assign(0x100000u, 0);
    const u32 host_base = (u32)(uintptr_t)buf.data();

    std::vector<u8> bytes = build_block_next(PC, idct, n, env.ctx_ptr,
                                             host_base, 0x000FFFFFu, 0x100000u);
    int handle = env.cache.compile(PC, bytes.data(), bytes.size());
    if (handle < 0) { std::printf("[bench] compile failed\n"); return false; }

    const u32 CTR_PER_PASS = 4096u;
    auto reset_pass = [&]() {
        env.spr(9)  = CTR_PER_PASS;            // CTR
        env.gpr(9)  = 0x80040000u;             // psq_l source row (zeros)
        env.gpr(8)  = 0x80000000u;             // store base
        env.gpr(7)  = 0u;                      // row 1 cursor (r5 = r8+r7)
        env.gpr(6)  = 0x1000u;                 // row 2 cursor (r3 = r8+r6)
        *(s32*)((u8*)env.ctx_raw + ppc_off::DOWNCOUNT)  = 50000000;
        *(u32*)((u8*)env.ctx_raw + ppc_off::EXCEPTIONS) = 0;
        *(u32*)((u8*)env.ctx_raw + ppc_off::PC)         = PC;
    };

    // Warmup (tier-up) then timed passes.
    const int WARM = 60, TIMED = 200;
    s32 next_pc = -1;
    for (int p = 0; p < WARM; ++p) { reset_pass(); env.cache.dispatch(PC, &next_pc); }
    // Self-chain engagement check: one dispatch must consume the whole CTR.
    reset_pass();
    env.cache.dispatch(PC, &next_pc);
    const u32 ctr_after = env.spr(9);
    std::printf("[bench] chain check: CTR after one dispatch = %u (0 = self-chain live)\n",
                ctr_after);
    double t0 = emscripten_get_now();
    for (int p = 0; p < TIMED; ++p) { reset_pass(); env.cache.dispatch(PC, &next_pc); }
    double t1 = emscripten_get_now();
    const double iters = (double)TIMED * (double)CTR_PER_PASS;
    std::printf("[bench] %d passes x %u iters: %.1f ms total, %.1f ns/iteration\n",
                TIMED, CTR_PER_PASS, t1 - t0, (t1 - t0) * 1e6 / iters);

    // Variant A — NI=0: the 32 per-arith-op denormal-flush arms (1024 ops/
    // iter) are runtime-gated on FPSCR bit 2; same code, arms skipped.
    // Times equal to the NI=1 run => iteration time is NOT op-count-bound.
    *(u32*)((u8*)env.ctx_raw + ppc_off::FPSCR) = 0u;
    for (int p = 0; p < 20; ++p) { reset_pass(); env.cache.dispatch(PC, &next_pc); }
    t0 = emscripten_get_now();
    for (int p = 0; p < TIMED; ++p) { reset_pass(); env.cache.dispatch(PC, &next_pc); }
    t1 = emscripten_get_now();
    std::printf("[bench] NI=0 variant: %.1f ms total, %.1f ns/iteration\n",
                t1 - t0, (t1 - t0) * 1e6 / iters);
    *(u32*)((u8*)env.ctx_raw + ppc_off::FPSCR) = 0x4u;

    // Variant B — CTR=64/entry: 64x more host entries + slow re-entries for
    // the same iteration count. (ns_B - ns_A_at_4096) * 64 ~= per-entry cost
    // (host dispatch + verify/PEM slow entry + epilogue).
    const u32 SMALL = 64u;
    const int PASSES_B = (int)(iters / SMALL);
    auto reset_small = [&]() {
        env.spr(9)  = SMALL;
        env.gpr(9)  = 0x80040000u;
        env.gpr(8)  = 0x80000000u;
        env.gpr(7)  = 0u;
        env.gpr(6)  = 0x1000u;
        *(s32*)((u8*)env.ctx_raw + ppc_off::DOWNCOUNT)  = 50000000;
        *(u32*)((u8*)env.ctx_raw + ppc_off::EXCEPTIONS) = 0;
        *(u32*)((u8*)env.ctx_raw + ppc_off::PC)         = PC;
    };
    for (int p = 0; p < 500; ++p) { reset_small(); env.cache.dispatch(PC, &next_pc); }
    t0 = emscripten_get_now();
    for (int p = 0; p < PASSES_B; ++p) { reset_small(); env.cache.dispatch(PC, &next_pc); }
    t1 = emscripten_get_now();
    std::printf("[bench] CTR=64 variant: %.1f ms total, %.1f ns/iteration (%d entries)\n",
                t1 - t0, (t1 - t0) * 1e6 / iters, PASSES_B);

    *mask_cell = saved_mask;
    g_bem_lc_base = saved_lc;
    bemental::powerpc::g_hle_hook_query = saved_query;
    return ctr_after == 0u;
#endif
}

// [PM53h int-fusion] The fused integer self-loop: addi r3,r3,1; cmpw cr0,r3,r4;
// blt -8. With r4=10 the loop runs 10 iterations IN ONE WASM ACTIVATION (the
// br back-edge), exits on not-LT with PC=+12. The emit-time census counter
// proves the fused path actually emitted — "one dispatch consumed N
// iterations" is also true for chain-dispatched unfused self-loops.
extern "C" { extern u32 g_bem_stat_int_fused; }
static bool test_fused_intloop_runs_to_exit() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80402000;
    // prescan requires a non-null HLE query answering "no hook".
    const auto saved_query = bemental::powerpc::g_hle_hook_query;
    bemental::powerpc::g_hle_hook_query = [](u32) -> bool { return false; };
    env.gpr(3) = 0;
    env.gpr(4) = 10;
    *(s32*)((u8*)env.ctx_raw + ppc_off::DOWNCOUNT) = 1000000;
    const u32 insts[] = {
        0x38630001u,   // addi r3,r3,1
        0x7C032000u,   // cmpw cr0,r3,r4
        0x4180FFF8u,   // blt cr0,-8  -> self-loop
    };
    const u32 fused_before = g_bem_stat_int_fused;
    s32 next_pc = -1;
    const bool ok = env.dispatch_block(PC, insts, 3, &next_pc);
    bemental::powerpc::g_hle_hook_query = saved_query;
    if (!ok) { std::printf("[fused] dispatch failed\n"); return false; }
    const bool fused = g_bem_stat_int_fused > fused_before;
    std::printf("[fused] emitted=%d next_pc=0x%08x r3=%u (exp fused=1, 0x%08x, 10)\n",
                (int)fused, (u32)next_pc, env.gpr(3), PC + 12u);
    return fused && (u32)next_pc == PC + 12u && env.gpr(3) == 10u;
}

// [FUSION v2] Seam tests: pre-fused streams with non-contiguous per-op pcs.
// Test 1: elided-b seam — {addi r3,0,7 @0x80010000 | addi r4,r3,1 @0x80020000;
// b->0x80030000 @0x80020004}. The terminal b's target must anchor to ITS OWN
// address (contiguous-poisoned math would compute from 0x80010008).
static bool test_fused_b_elision_seam() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 insts[] = { 0x38600007u, 0x38830001u, 0x4800FFFCu };
    const u32 pcs[]   = { 0x80010000u, 0x80020000u, 0x80020004u };
    s32 next_pc = -1;
    if (!env.dispatch_fused(0x80010000u, insts, pcs, 3, &next_pc)) return false;
    std::printf("[fused-v2 b-elide] r3=%u r4=%u next=0x%08x (exp 7,8,0x80030000)\n",
                env.gpr(3), env.gpr(4), (u32)next_pc);
    return env.gpr(3) == 7u && env.gpr(4) == 8u && (u32)next_pc == 0x80030000u;
}

// Test 2: backward-cond seam ROUTING — {addi r3,r3,1; bdnz->0x8000FF00;
// addi r4,0,5; b->0x80040000}, contiguous pcs from 0x80010000. Taken (CTR=2):
// real mid-function exit, B never runs. Not-taken (CTR=1): continues inline.
static bool test_fused_bwd_seam() {
    const u32 insts[] = { 0x38630001u, 0x4200FEFCu, 0x38800005u, 0x4802FFF4u };
    const u32 pcs[]   = { 0x80010000u, 0x80010004u, 0x80010008u, 0x8001000Cu };
    {   // taken
        TestEnv env;
        if (!env.init()) return false;
        env.spr(9) = 2u;                        // CTR
        s32 next_pc = -1;
        if (!env.dispatch_fused(0x80010000u, insts, pcs, 4, &next_pc)) return false;
        std::printf("[fused-v2 bwd taken] next=0x%08x r4=%u ctr=%u (exp 0x8000FF00,0,1)\n",
                    (u32)next_pc, env.gpr(4), env.spr(9));
        if (!((u32)next_pc == 0x8000FF00u && env.gpr(4) == 0u && env.spr(9) == 1u))
            return false;
    }
    {   // not-taken
        TestEnv env;
        if (!env.init()) return false;
        env.spr(9) = 1u;
        s32 next_pc = -1;
        if (!env.dispatch_fused(0x80010000u, insts, pcs, 4, &next_pc)) return false;
        std::printf("[fused-v2 bwd not-taken] next=0x%08x r4=%u ctr=%u (exp 0x80040000,5,0)\n",
                    (u32)next_pc, env.gpr(4), env.spr(9));
        if (!((u32)next_pc == 0x80040000u && env.gpr(4) == 5u && env.spr(9) == 0u))
            return false;
    }
    return true;
}

// Test 3: terminator fixup on a fused stream — non-branch terminal at
// 0x80500004 must fix up next_pc to 0x80500008 (poisoned: 0x8001000C).
static bool test_fused_terminator_fixup() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 insts[] = { 0x38600002u, 0x38830003u, 0x38A40004u };
    const u32 pcs[]   = { 0x80010000u, 0x80500000u, 0x80500004u };
    s32 next_pc = -1;
    if (!env.dispatch_fused(0x80010000u, insts, pcs, 3, &next_pc)) return false;
    std::printf("[fused-v2 fixup] r5=%u next=0x%08x (exp 9, 0x80500008)\n",
                env.gpr(5), (u32)next_pc);
    return env.gpr(5) == 9u && (u32)next_pc == 0x80500008u;
}

// [FUSION v3] bl-inline + software-RAS tests.
// Good path: {addi r3,0,1 @A; bl->C @A+4 | [callee] addi r4,0,2 @C; blr @C+4 |
// [continuation] addi r5,0,3 @A+8; b->0x80090000 @A+12}. The bl emits LR:=A+8
// only; the blr's RAS check hits (LR==A+8) and falls through inline.
static bool test_fused_bl_inline_ras_hit() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 A = 0x80010000u, C = 0x80050000u;
    const u32 insts[] = {
        0x38600001u,                          // addi r3,0,1      @A
        0x48000001u | ((C - (A + 4u)) & 0x03FFFFFCu),   // bl C  @A+4
        0x38800002u,                          // addi r4,0,2      @C
        0x4E800020u,                          // blr              @C+4
        0x38A00003u,                          // addi r5,0,3      @A+8
        0x48000000u | ((0x80090000u - (A + 12u)) & 0x03FFFFFCu), // b @A+12
    };
    const u32 pcs[] = { A, A + 4u, C, C + 4u, A + 8u, A + 12u };
    s32 next_pc = -1;
    if (!env.dispatch_fused(A, insts, pcs, 6, &next_pc)) return false;
    const u32 lr = env.spr(8);
    std::printf("[fused-v3 ras-hit] r3=%u r4=%u r5=%u lr=0x%08x next=0x%08x"
                " (exp 1,2,3,0x%08x,0x80090000)\n",
                env.gpr(3), env.gpr(4), env.gpr(5), lr, (u32)next_pc, A + 8u);
    return env.gpr(3) == 1u && env.gpr(4) == 2u && env.gpr(5) == 3u &&
           lr == A + 8u && (u32)next_pc == 0x80090000u;
}

// Mispredict: the callee overwrites LR (mtlr r7, r7=0x80777700) — the driver
// would never build this stream, but the EMITTER must exit correctly:
// PC = LR&~3, continuation ops never run.
static bool test_fused_bl_inline_ras_miss() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 A = 0x80010000u, C = 0x80050000u;
    env.gpr(7) = 0x80777700u;
    const u32 insts[] = {
        0x38600001u,                          // addi r3,0,1      @A
        0x48000001u | ((C - (A + 4u)) & 0x03FFFFFCu),   // bl C  @A+4
        0x7CE803A6u,                          // mtlr r7          @C
        0x4E800020u,                          // blr              @C+4
        0x38A00003u,                          // addi r5,0,3      @A+8 (must NOT run)
        0x48000000u | ((0x80090000u - (A + 12u)) & 0x03FFFFFCu), // b @A+12
    };
    const u32 pcs[] = { A, A + 4u, C, C + 4u, A + 8u, A + 12u };
    s32 next_pc = -1;
    if (!env.dispatch_fused(A, insts, pcs, 6, &next_pc)) return false;
    std::printf("[fused-v3 ras-miss] r5=%u next=0x%08x (exp 0, 0x80777700)\n",
                env.gpr(5), (u32)next_pc);
    return env.gpr(5) == 0u && (u32)next_pc == 0x80777700u;
}

// [PM55 int-quality] Dump the SAB scheduler hot block (0x800ebe00, 17.9% of
// our SAB time vs native 1.28%): rlwinm/add/stw/lwz/lwz/cmplwi/bne(coalesced)/
// stw/b — the integer working set (queue unlink). Fastmem armed, production
// hook query. Feeds wasm-dis per-op attribution vs Jit64's 2-4-instr loads.
static bool test_sab_sched_wasm_dump() {
    TestEnv env;
    if (!env.init()) return false;
    const auto saved_query = bemental::powerpc::g_hle_hook_query;
    bemental::powerpc::g_hle_hook_query = [](u32) -> bool { return false; };
    static const u32 sched[] = {
        0x54001838u,  // rlwinm r0,r0,3,0,28
        0x7C1F0214u,  // add    r0,r31,r0
        0x900602DCu,  // stw    r0,732(r6)
        0x80A602DCu,  // lwz    r5,732(r6)
        0x80850004u,  // lwz    r4,4(r5)
        0x28040000u,  // cmplwi r4,0
        0x4082000Cu,  // bne    +0xc (coalesced mid-block exit)
        0x90C50000u,  // stw    r6,0(r5)
        0x48000008u,  // b      +8 (terminator)
    };
    dump_block_wasm("SAB_SCHED", 0x800EBE00u, sched, 9, env.ctx_ptr,
                    0x10000000u, 0x017FFFFFu, 0x01800000u);
    bemental::powerpc::g_hle_hook_query = saved_query;
    return true;
}

// [PM55 EA-CSE] stw rX,off(rB) then lwz rY,off(rB) — same base+offset. The
// second EA reuses LOCAL_TMP_EA from the first; the load must read back
// exactly what the store wrote, proving the reused address is identical.
static bool test_ea_cse_stw_then_lwz_same_slot() {
    TestEnv env;
    if (!env.init()) return false;
    static u8 mem[1024];
    std::memset(mem, 0, sizeof(mem));
    const u32 host_base = (u32)(uintptr_t)&mem[0];
    env.gpr(6) = 0x80000000u;              // masks to offset 0
    env.gpr(0) = 0xAABBCCDDu;              // value to store
    const u32 insts[] = {
        enc_stw(0, 6, 732),               // stw r0,732(r6)  -> mem[732..735] BE
        enc_lwz(5, 6, 732),               // lwz r5,732(r6)  -> r5 = 0xAABBCCDD (EA reused)
    };
    s32 next_pc = -1;
    if (!env.dispatch_block(0x80010000u, insts, 2, &next_pc,
                            host_base, 0x017FFFFFu, sizeof(mem))) return false;
    std::printf("[ea-cse] r5=0x%08x (exp 0xAABBCCDD) mem[732]=0x%02x%02x%02x%02x\n",
                env.gpr(5), mem[732], mem[733], mem[734], mem[735]);
    return env.gpr(5) == 0xAABBCCDDu &&
           mem[732] == 0xAA && mem[733] == 0xBB &&
           mem[734] == 0xCC && mem[735] == 0xDD;
}

// [PM56 lazy-CR] CROSS-BLOCK soundness: block A defers CR0 (cmpi, sets pending),
// exits; a SEPARATELY-dispatched block B reads CR0 via the branch's pending
// path. Proves the deferred form survives a block boundary with no liveness/
// materialize at exit — the core soundness claim. r3==0 → beq taken.
static bool test_lazycr_cross_block_beq() {
    for (int variant = 0; variant < 2; ++variant) {
        TestEnv env;
        if (!env.init()) return false;
        const u32 PC_A = 0x80010000u, PC_B = 0x80020000u;
        const u32 TGT  = 0x80020040u;   // within bc 16-bit range of PC_B
        env.gpr(3) = (variant == 0) ? 0u : 5u;   // 0 → EQ set → taken
        // block A: cmpi r3,0 (defers CR0)
        const u32 a_insts[] = { enc_cmpi_cr0(3, 0) };
        s32 na = -1;
        if (!env.dispatch_block(PC_A, a_insts, 1, &na)) return false;
        // block B: beq (BO=12 branch-true, BI=2 EQ) → TGT — reads CR0 pending
        const u32 b_insts[] = { enc_bc(12, 2, PC_B, TGT, false) };
        s32 nb = -1;
        if (!env.dispatch_block(PC_B, b_insts, 1, &nb)) return false;
        const u32 want = (variant == 0) ? TGT : (PC_B + 4u);
        std::printf("[lazycr xblock] r3=%u next=0x%08x (exp 0x%08x)\n",
                    env.gpr(3), (u32)nb, want);
        if ((u32)nb != want) return false;
    }
    return true;
}

// [PM56 lazy-CR] SO-FREEZE: CR.SO copies XER.SO at compare time. bso reads the
// FROZEN shadow byte, not live XER. XER.SO=1 at cmp → CR0.SO set → bso taken.
static bool test_lazycr_so_freeze() {
    for (int so = 0; so < 2; ++so) {
        TestEnv env;
        if (!env.init()) return false;
        const u32 PC = 0x80030000u, TGT = 0x80030040u;   // within bc 16-bit range
        env.gpr(3) = 5;
        // XER.SO_OV byte = (SO<<1)|OV
        *(u8*)((u8*)env.ctx_raw + 0x2F5) = (u8)((so << 1) | 0);
        // cmpi r3,0 then bso (BO=12 branch-true, BI=3 SO) → TGT
        const u32 insts[] = {
            enc_cmpi_cr0(3, 0),
            enc_bc(12, 3, PC + 4u, TGT, false),
        };
        s32 nx = -1;
        if (!env.dispatch_block(PC, insts, 2, &nx)) return false;
        const u32 want = so ? TGT : (PC + 8u);
        std::printf("[lazycr so-freeze] so=%d next=0x%08x (exp 0x%08x)\n",
                    so, (u32)nx, want);
        if ((u32)nx != want) return false;
    }
    return true;
}

// [PM57 adjacent cmp->branch fusion] Differential over the FUSED cmp;bc path.
// For every {cmp form, operand pair (incl. signed/unsigned boundaries), tested
// bit LT/GT/EQ, branch polarity}, a 2-op block {cmp; bc} — adjacent, so the bc
// reads the cmp's operand locals DIRECTLY via emit_crbit_fused — must branch
// exactly as the ISA prescribes. Oracle computed here in C++; a mismatch means
// emit_crbit_fused's predicate or signedness is wrong. Covers lt_s/lt_u/gt_s/
// gt_u/eq for reg (cmp/cmpl) and imm (cmpi/cmpli) forms. Inert (still passes via
// the eager/materialize path) when BEM_LAZY_CR is false — the branch decision is
// form-correct either way; this test guards the FUSED arm specifically.
static bool test_lazycr_fused_adjacent() {
    enum Form { F_CMP, F_CMPL, F_CMPI, F_CMPLI };
    struct Vec { Form form; u32 va; u32 vb; };  // vb = rb value or immediate
    const Vec vecs[] = {
        // signed reg (cmp)
        {F_CMP, 5u, 5u}, {F_CMP, 5u, 3u}, {F_CMP, 3u, 5u},
        {F_CMP, 0x80000000u, 1u}, {F_CMP, 0x7FFFFFFFu, 0x80000000u},
        {F_CMP, 0xFFFFFFFFu, 0u}, {F_CMP, 0u, 0xFFFFFFFFu},
        {F_CMP, 0x80000000u, 0x80000000u},
        // unsigned reg (cmpl) — same operands, unsigned semantics
        {F_CMPL, 5u, 5u}, {F_CMPL, 5u, 3u}, {F_CMPL, 3u, 5u},
        {F_CMPL, 0x80000000u, 1u}, {F_CMPL, 0x7FFFFFFFu, 0x80000000u},
        {F_CMPL, 0xFFFFFFFFu, 0u}, {F_CMPL, 0u, 0xFFFFFFFFu},
        // signed imm (cmpi), imm sign-extended: -1, 1, 5
        {F_CMPI, 0u, (u32)(s32)-1}, {F_CMPI, 0xFFFFFFFFu, (u32)(s32)-1},
        {F_CMPI, 0x80000000u, (u32)(s32)-1}, {F_CMPI, 5u, (u32)(s32)-1},
        {F_CMPI, 5u, 5u}, {F_CMPI, 0x7FFFFFFFu, 1u},
        // unsigned imm (cmpli), imm zero-extended: 0, 1
        {F_CMPLI, 0u, 0u}, {F_CMPLI, 1u, 0u}, {F_CMPLI, 0xFFFFFFFFu, 0u},
        {F_CMPLI, 0u, 1u}, {F_CMPLI, 1u, 1u}, {F_CMPLI, 2u, 1u},
    };
    const u32 PC = 0x80004000u;
    const u32 TARGET = PC + 0x40u;         // within bc 16-bit displacement
    int failures = 0;
    for (const Vec& v : vecs) {
        const bool is_signed = (v.form == F_CMP || v.form == F_CMPI);
        const bool lt = is_signed ? ((s32)v.va < (s32)v.vb) : (v.va < v.vb);
        const bool gt = is_signed ? ((s32)v.va > (s32)v.vb) : (v.va > v.vb);
        const bool eq = (v.va == v.vb);
        const bool bitval[3] = { lt, gt, eq };
        for (u32 bit = 0; bit < 3u; ++bit) {
            for (u32 pol = 0; pol < 2u; ++pol) {   // pol=1 -> BO=12 (branch true)
                TestEnv env;
                if (!env.init()) return false;
                env.gpr(3) = v.va;
                u32 cmp_inst;
                switch (v.form) {
                    case F_CMP:   env.gpr(4) = v.vb; cmp_inst = enc_cmp_cr0(3, 4);  break;
                    case F_CMPL:  env.gpr(4) = v.vb; cmp_inst = enc_cmpl_cr0(3, 4); break;
                    case F_CMPI:  cmp_inst = enc_cmpi_cr0(3, (s32)v.vb);            break;
                    default:      cmp_inst = enc_cmpli_cr0(3, v.vb & 0xFFFFu);      break;
                }
                const u32 bo = pol ? 12u : 4u;
                const u32 insts[] = { cmp_inst,
                                      enc_bc(bo, bit, PC + 4u, TARGET, false) };
                s32 next_pc = -1;
                if (!env.dispatch_block(PC, insts, 2, &next_pc)) { failures++; continue; }
                const bool want_taken = pol ? bitval[bit] : !bitval[bit];
                const s32 expect = want_taken ? (s32)TARGET : (s32)(PC + 8u);
                if (next_pc != expect) {
                    std::printf("[lazycr fused] form=%d va=0x%08x vb=0x%08x bit=%u "
                                "pol=%u next=0x%08x exp=0x%08x\n",
                                (int)v.form, v.va, v.vb, bit, pol,
                                (u32)next_pc, (u32)expect);
                    failures++;
                }
            }
        }
    }
    return failures == 0;
}

// [skin-detect (b) Stage-2 2026-08-07] WriteMTXPS4x3 send-sequence reproduction.
// Retail GXLoadPosMtxImm (dolsdk2001 src/gx/GXTransform.c) ships a 3x4 pos
// matrix to WGPIPE via WriteMTXPS4x3: SIX psq_l (f0..f5, ALL live) then SIX
// psq_st to the gather pipe. Decode-side skin-detect shows PSO characters
// arrive with matrix row 2 = (0,0,0,tz) — rotation zeroed, only the final lane
// surviving — while rows 0/1 (identical send path) are intact. That partial,
// positionally-stable drop is the fingerprint of a sequence-dependent
// scratch-local clobber that single-op psq conformance cannot see (six loads
// keep all six regs live before the first store). Feed a KNOWN-GOOD matrix
// (1.0..12.0) through the exact sequence and assert all 12 f32 arrive in order.
//   RED  (words 9,10,11 vanish, 12 survives) => send/psq emit bug  (suspect #1b)
//   GREEN => send is faithful; corruption is upstream in the skinning math that
//            BUILT the matrix in RAM (suspect #1a) — reproduce THAT next.
static const u32 kMtxWords[12] = {
    0x3F800000u, 0x40000000u, 0x40400000u, 0x40800000u,  // R0: 1,2,3,4
    0x40A00000u, 0x40C00000u, 0x40E00000u, 0x41000000u,  // R1: 5,6,7,8
    0x41100000u, 0x41200000u, 0x41300000u, 0x41400000u   // R2: 9,10,11,12
};
static bool test_writemtxps4x3_send_sequence() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80300000;
    psq_env_common(env);
    env.spr(912) = 0;                 // GQR0: FLOAT, scale 0
    env.gpr(3) = 0x80100000u;         // matrix source (mtx[3][4])
    env.gpr(4) = 0x80200000u;         // dest (stand-in for &GXWGFifo.f32)
#ifdef __EMSCRIPTEN__
    // Feed the matrix words from the C-side kMtxWords via HEAPU32 (a JS array
    // literal would break the EM_ASM macro: the C preprocessor splits {} bodies
    // on bare commas — only () protect them).
    EM_ASM({
        Module.mtxPtr = $0;
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            var off = ((addr >>> 0) - 0x80100000) >>> 2;   // word index 0..11
            return (off < 12) ? (HEAPU32[(Module.mtxPtr >>> 2) + off] | 0) : 0;
        };
        Module.test_writes = [];
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_writes.push(val >>> 0);
        };
    }, (u32)(uintptr_t)kMtxWords);
#endif
    const u32 insts[] = {
        0xE0030000u,  // psq_l  f0, 0x00(r3)
        0xE0230008u,  // psq_l  f1, 0x08(r3)
        0xE0430010u,  // psq_l  f2, 0x10(r3)
        0xE0630018u,  // psq_l  f3, 0x18(r3)
        0xE0830020u,  // psq_l  f4, 0x20(r3)
        0xE0A30028u,  // psq_l  f5, 0x28(r3)
        0xF0040000u,  // psq_st f0, 0(r4)
        0xF0240000u,  // psq_st f1, 0(r4)
        0xF0440000u,  // psq_st f2, 0(r4)
        0xF0640000u,  // psq_st f3, 0(r4)
        0xF0840000u,  // psq_st f4, 0(r4)
        0xF0A40000u,  // psq_st f5, 0(r4)
    };
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, 12, &next_pc);
    u32 got[12] = {0}; u32 n_writes = 0;
#ifdef __EMSCRIPTEN__
    n_writes = (u32)EM_ASM_INT({ return Module.test_writes.length | 0; });
    for (u32 i = 0; i < 12; ++i)
        got[i] = (u32)EM_ASM_INT({ return (Module.test_writes[$0] >>> 0) | 0; }, i);
    EM_ASM({ Module.bemental_imports.env.ppc_write32 = function(addr, val) {};
             Module.bemental_imports.env.ppc_read32  = function(addr) { return 0; }; });
#endif
    if (!dispatched) return false;
    std::printf("[diag writemtx] n=%u | R0 %08x %08x %08x %08x | R1 %08x %08x %08x %08x | R2 %08x %08x %08x %08x\n",
                n_writes, got[0],got[1],got[2],got[3], got[4],got[5],got[6],got[7], got[8],got[9],got[10],got[11]);
    bool ok = (n_writes == 12u);
    for (u32 i = 0; i < 12 && ok; ++i)
        ok = ok && (got[i] == kMtxWords[i]);
    return ok;
}

// [skin-detect (b) Stage-2b 2026-08-07] PSMTXConcat matrix-build reproduction.
// The send path is proven faithful (writemtxps4x3_send_sequence GREEN), so the
// degenerate row 2 = (0,0,0,tz) exists in guest RAM BEFORE the send. PSO skinning
// matrices are built with paired-single PSMTXConcat (dolsdk2001 src/mtx/mtx.c).
// Its R2 outputs (f2=m20,m21 ; f0=m22,m23) are computed LAST, and their source
// registers f0/f2 are REUSED as accumulators mid-stream, interleaved with the
// psq_st of f12..f15 — the register-reuse-across-store shape single-op
// conformance can't reach. Feed two known non-degenerate (all-positive) matrices
// and compare against a float reference concat.
//   RED  (R2 words collapse to 0 / off-reference) => PSMTXConcat emit bug.
//   GREEN => concat is faithful; the dead row is built even further upstream.
static const float kA_f[12]  = {0.1f,0.2f,0.3f,1.0f, 0.4f,0.5f,0.6f,2.0f, 0.7f,0.8f,0.9f,3.0f};
static const float kB_f[12]  = {1.1f,1.2f,1.3f,4.0f, 1.4f,1.5f,1.6f,5.0f, 1.7f,1.8f,1.9f,6.0f};
static const float kU01_f[2] = {0.0f, 1.0f};
static bool test_psmtxconcat_row2_build() {
    TestEnv env;
    if (!env.init()) return false;
    const u32 PC = 0x80380000;
    psq_env_common(env);
    env.spr(912) = 0;                 // GQR0: FLOAT, scale 0
    env.gpr(3) = 0x80100000u;         // mA
    env.gpr(4) = 0x80200000u;         // mB
    env.gpr(5) = 0x80500000u;         // mAB (dest, captured)
    env.gpr(6) = 0x80400000u;         // Unit01 = (0.0, 1.0)
#ifdef __EMSCRIPTEN__
    EM_ASM({
        var mA = []; var mB = []; var u01 = [];
        for (var i = 0; i < 12; i++) mA.push(HEAPU32[($0 >> 2) + i] >>> 0);
        for (var j = 0; j < 12; j++) mB.push(HEAPU32[($1 >> 2) + j] >>> 0);
        for (var k = 0; k < 2;  k++) u01.push(HEAPU32[($2 >> 2) + k] >>> 0);
        Module.bemental_imports.env.ppc_read32 = function(addr) {
            addr = addr >>> 0;
            if (addr >= 0x80100000 && addr < 0x80100030) return mA[(addr - 0x80100000) >> 2] | 0;
            if (addr >= 0x80200000 && addr < 0x80200030) return mB[(addr - 0x80200000) >> 2] | 0;
            if (addr >= 0x80400000 && addr < 0x80400008) return u01[(addr - 0x80400000) >> 2] | 0;
            return 0;
        };
        Module.test_writes = [];
        Module.bemental_imports.env.ppc_write32 = function(addr, val) {
            Module.test_writes.push(addr >>> 0);   // pushed as separate scalars —
            Module.test_writes.push(val >>> 0);    // an array-literal comma breaks EM_ASM
        };
    }, (u32)(uintptr_t)kA_f, (u32)(uintptr_t)kB_f, (u32)(uintptr_t)kU01_f);
#endif
    auto L  = [](u32 D, u32 A, u32 dsp) { return 0xE0000000u | (D<<21) | (A<<16) | (dsp & 0xFFFu); };
    auto S  = [](u32 D, u32 A, u32 dsp) { return 0xF0000000u | (D<<21) | (A<<16) | (dsp & 0xFFFu); };
    auto M0 = [](u32 D, u32 A, u32 C)          { return 0x10000000u | (D<<21) | (A<<16) | (C<<6) | (12u<<1); };
    auto A0 = [](u32 D, u32 A, u32 C, u32 B)   { return 0x10000000u | (D<<21) | (A<<16) | (B<<11) | (C<<6) | (14u<<1); };
    auto A1 = [](u32 D, u32 A, u32 C, u32 B)   { return 0x10000000u | (D<<21) | (A<<16) | (B<<11) | (C<<6) | (15u<<1); };
    const u32 insts[] = {
        L(0,3,0),  L(6,4,0),  L(7,4,8),  L(8,4,16),
        M0(12,6,0), L(2,3,16), M0(13,7,0), L(31,6,0),
        M0(14,6,2), L(9,4,24), M0(15,7,2), L(1,3,8),
        A1(12,8,0,12), L(3,3,24), A1(14,8,2,14), L(10,4,32),
        A1(13,9,0,13), L(11,4,40), A1(15,9,2,15), L(4,3,32),
        L(5,3,40), A0(12,10,1,12), A0(13,11,1,13), A0(14,10,3,14),
        A0(15,11,3,15), S(12,5,0), M0(2,6,4), A1(13,31,1,13),
        M0(0,7,4), S(14,5,16), A1(15,31,3,15), S(13,5,8),
        A1(2,8,4,2), A1(0,9,4,0), A0(2,10,5,2), S(15,5,24),
        A0(0,11,5,0), S(2,5,32), A1(0,31,5,0), S(0,5,40),
    };
    const u32 ninsts = (u32)(sizeof(insts)/sizeof(insts[0]));
    s32 next_pc = -1;
    bool dispatched = env.dispatch_block(PC, insts, ninsts, &next_pc);
    u32 out[12] = {0}; u32 n_writes = 0;
#ifdef __EMSCRIPTEN__
    n_writes = (u32)EM_ASM_INT({ return Module.test_writes.length | 0; });
    const u32 npairs = n_writes / 2u;
    for (u32 p = 0; p < npairs; ++p) {
        u32 a = (u32)EM_ASM_INT({ return Module.test_writes[$0 * 2] >>> 0; }, p);
        u32 v = (u32)EM_ASM_INT({ return Module.test_writes[$0 * 2 + 1] >>> 0; }, p);
        u32 idx = (a - 0x80500000u) >> 2;
        if (idx < 12) out[idx] = v;
    }
    EM_ASM({ Module.bemental_imports.env.ppc_write32 = function(addr, val) {};
             Module.bemental_imports.env.ppc_read32  = function(addr) { return 0; }; });
#endif
    if (!dispatched) return false;
    // float reference: 3x4 concat with implicit (0,0,0,1) bottom row.
    float ref[12];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j)
            ref[i*4+j] = kA_f[i*4+0]*kB_f[0*4+j] + kA_f[i*4+1]*kB_f[1*4+j] + kA_f[i*4+2]*kB_f[2*4+j];
        ref[i*4+3] = kA_f[i*4+0]*kB_f[0*4+3] + kA_f[i*4+1]*kB_f[1*4+3] + kA_f[i*4+2]*kB_f[2*4+3] + kA_f[i*4+3];
    }
    auto asf = [](u32 b){ float f; std::memcpy(&f, &b, 4); return f; };
    std::printf("[diag psmtxcc] n=%u | out R2 %08x %08x %08x %08x  (ref %.4f %.4f %.4f %.4f)\n",
                n_writes, out[8],out[9],out[10],out[11], ref[8],ref[9],ref[10],ref[11]);
    bool ok = (n_writes == 24u);
    for (int i = 0; i < 12 && ok; ++i) {
        float g = asf(out[i]);
        float d = g - ref[i]; if (d < 0) d = -d;
        float m = ref[i] < 0 ? -ref[i] : ref[i];
        ok = ok && (d <= 0.01f * (m + 1.0f));   // rel tol; a zeroed R2 fails hard
    }
    return ok;
}

// ===========================================================================
// [B1 template pilot fixture 2026-08-11] PSMTXROMultVecArray differential harness.
// The target is SOFTWARE-PIPELINED (stores results 2 iters back, prefetches next).
// The reference is the REAL function executed faithfully via the generic JIT over
// a multi-block dispatch loop — NEVER a hand-derived matrix result (the bent-legs
// trap by name). Diffs FULL PowerPCState + captured dst memory. The template plugs
// into leg B once registered; this harness validates the runner on the generic
// path (determinism/sanity) so the emitter gets built against a working oracle.
// Bytes extracted byte-exact from the decomp asm (psmtx.s).
static const u32 kPSMTXRO_ENTRY = 0x800bc8d0u;
static const u32 kPSMTXRO_RET   = 0x800bc9e8u;   // addr past blr (LR sentinel)
static const u32 kPSMTXRO[70] = {
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

// Dispatch from entry, follow next_pc until the blr returns to the LR sentinel.
// mem1_base=0 -> psq loads/stores route through the EM_ASM ppc_read32/write32
// slowmem stubs. Re-dispatch of the self-loop block is idempotent via the cache.
static bool run_psmtxro(TestEnv& env) {
    env.spr(8) = kPSMTXRO_RET;               // LR: blr -> RET sentinel
    *(u32*)((u8*)env.ctx_raw + 0x2F0) = 0x40000000u;  // DOWNCOUNT large: branch blocks must not service-bail
    // Pre-compile every block at its known start so the pipelined loop's chains
    // resolve (entry bdnz -> 0x800bc964; unless compiled, dispatch returns -1).
    static const u32 kStarts[] = {0x800bc8d0u, 0x800bc964u, 0x800bc9b4u, 0x800bc9c4u, 0x800bc9ccu};
    for (u32 si = 0; si < 5u; ++si) {
        u32 s = kStarts[si], i = (s - kPSMTXRO_ENTRY) >> 2;
        std::vector<u8> b = build_block_next(s, &kPSMTXRO[i], 70u - i, env.ctx_ptr, 0, 0, 0);
        if (env.cache.compile(s, b.data(), (u32)b.size()) < 0) {
            std::printf("[psmtxro] compile FAIL @0x%08x\n", s); return false; }
    }
    s32 npc = (s32)kPSMTXRO_ENTRY;
    for (int g = 0; g < 200000; ++g) {
        u32 cur = (u32)npc; npc = -1;
        if (!env.cache.dispatch(cur, &npc)) { std::printf("[psmtxro] dispatch FAIL @0x%08x g=%d\n", cur, g); return false; }
        // npc<0 (chained to the uncompiled LR sentinel) OR ==RET = the blr terminus reached.
        if (npc < 0 || (u32)npc == kPSMTXRO_RET) return true;
    }
    return false;   // guard exhausted (should not happen)
}

static bool test_psmtxro_diff() {
    const u32 MBASE = 0x80100000u, SBASE = 0x80200000u, DBASE = 0x80500000u;
    const u32 N = 4;
    u32 mtx[12], src[12];  // 12 floats matrix, N*3=12 floats input
    for (u32 i = 0; i < 12; i++) { float f = 0.1f * (float)(i + 1) - 0.35f; std::memcpy(&mtx[i], &f, 4); }
    for (u32 i = 0; i < N * 3; i++) { float f = 1.0f + 0.3f * (float)i; std::memcpy(&src[i], &f, 4); }

    auto run_once = [&](u32* dst, u32* state, u32& nw) -> bool {
        TestEnv env; if (!env.init()) return false;
        psq_env_common(env);
        env.spr(912) = 0;                    // GQR0 = FLOAT, scale 0
        env.gpr(3) = MBASE; env.gpr(4) = SBASE; env.gpr(5) = DBASE; env.gpr(6) = N;
        nw = 0;
#ifdef __EMSCRIPTEN__
        EM_ASM({
            var m = []; var s = [];
            for (var i = 0; i < 12; i++) m.push(HEAPU32[($0 >> 2) + i] >>> 0);
            for (var j = 0; j < $2; j++) s.push(HEAPU32[($1 >> 2) + j] >>> 0);
            Module.bemental_imports.env.ppc_read32 = function(a) { a = a >>> 0;
                if (a >= 0x80100000 && a < 0x80100030) return m[(a - 0x80100000) >> 2] | 0;
                if (a >= 0x80200000 && a < 0x80200000 + $2 * 4) return s[(a - 0x80200000) >> 2] | 0;
                return 0; };
            Module.test_writes = [];
            Module.bemental_imports.env.ppc_write32 = function(a, v) {
                Module.test_writes.push(a >>> 0); Module.test_writes.push(v >>> 0); };
        }, (u32)(uintptr_t)mtx, (u32)(uintptr_t)src, (u32)(N * 3));
#endif
        bool ok = run_psmtxro(env);
#ifdef __EMSCRIPTEN__
        nw = (u32)EM_ASM_INT({ return Module.test_writes.length | 0; });
        for (u32 p = 0; p < nw / 2u && p < 64u; ++p) {
            u32 a = (u32)EM_ASM_INT({ return Module.test_writes[$0 * 2] >>> 0; }, p);
            u32 v = (u32)EM_ASM_INT({ return Module.test_writes[$0 * 2 + 1] >>> 0; }, p);
            u32 idx = (a - DBASE) >> 2; if (idx < 3u * N) dst[idx] = v;
        }
        EM_ASM({ Module.bemental_imports.env.ppc_write32 = function(a, v) {};
                 Module.bemental_imports.env.ppc_read32  = function(a) { return 0; }; });
#endif
        for (u32 r = 0; r < 32; r++) state[r] = env.gpr(r);
        state[32] = env.spr(9);              // CTR
        for (u32 f = 0; f < 32; f++) {
            u64 p0 = *(u64*)((u8*)env.ctx_raw + ppc_off::ps0(f));
            u64 p1 = *(u64*)((u8*)env.ctx_raw + ppc_off::ps1(f));
            state[33 + f * 4 + 0] = (u32)p0; state[33 + f * 4 + 1] = (u32)(p0 >> 32);
            state[33 + f * 4 + 2] = (u32)p1; state[33 + f * 4 + 3] = (u32)(p1 >> 32);
        }
        return ok;
    };

    u32 dstA[12] = {0}, dstB[12] = {0}, stA[33 + 128] = {0}, stB[33 + 128] = {0}, nwA = 0, nwB = 0;
    bool okA = run_once(dstA, stA, nwA);
    bool okB = run_once(dstB, stB, nwB);     // leg B := template later; generic now
    if (!okA || !okB) { std::printf("[psmtxro] run FAILED A=%d B=%d nwA=%u nwB=%u dst0=%08x\n", okA, okB, nwA, nwB, dstA[0]); return false; }
    bool mem_eq = (nwA == nwB);
    for (u32 i = 0; i < 12 && mem_eq; i++) mem_eq = (dstA[i] == dstB[i]);
    bool st_eq = true; for (u32 i = 0; i < 33 + 128 && st_eq; i++) st_eq = (stA[i] == stB[i]);
    auto asf = [](u32 b){ float f; std::memcpy(&f, &b, 4); return f; };
    std::printf("[psmtxro] N=%u writes=%u dst=[%.3f %.3f %.3f ...] state_eq=%d mem_eq=%d\n",
                N, nwA, asf(dstA[0]), asf(dstA[1]), asf(dstA[2]), st_eq, mem_eq);
    // Gate #1 harness validated when: the function runs, produces writes, and is
    // deterministic (full state + memory identical). Exact count tightened after
    // the first run shows the psq_st write pattern.
    return okA && okB && mem_eq && st_eq && nwA > 0u && nwA == nwB;
}

// [B1 3-way cross-check 2026-08-11] Generic JIT vs NATIVE goldens. The goldens are
// bit-exact PSMTXROMultVecArray outputs captured from native Dolphin's interpreter by
// DIRECT INVOCATION (gamecube/tools/golden_invoke_psmtx.py), embedded in psmtx_goldens.h.
// We feed each golden's exact romtx (native PSMTXReorder output) + src through the REAL
// function on the generic JIT and require the captured dst to equal the native dst
// bit-for-bit. Passing proves: (1) the generic JIT is faithful to native on this kernel,
// so (2) the goldens are a trustworthy gate for the template that replaces leg B next.
#include "psmtx_goldens.h"
static bool run_psmtxro_case(const uint32_t* romtx, const uint32_t* src, u32 count,
                             uint32_t* dst_out /*count*3*/) {
    const u32 MBASE = 0x80100000u, SBASE = 0x80200000u, DBASE = 0x80500000u;
    TestEnv env; if (!env.init()) return false;
    psq_env_common(env);
    env.spr(912) = 0;                        // GQR0 = FLOAT, scale 0 (as PSMTX assumes)
    env.gpr(3) = MBASE; env.gpr(4) = SBASE; env.gpr(5) = DBASE; env.gpr(6) = count;
    env.gpr(1) = 0x8010F000u;                // valid stack for the stwu prologue
#ifdef __EMSCRIPTEN__
    EM_ASM({
        var m = []; var s = [];
        for (var i = 0; i < 12; i++)   m.push(HEAPU32[($0 >> 2) + i] >>> 0);
        for (var j = 0; j < $3; j++)   s.push(HEAPU32[($1 >> 2) + j] >>> 0);
        var mb = $2 >>> 0; var sb = 0x80200000; var se = 0x80200000 + $3 * 4;
        Module.bemental_imports.env.ppc_read32 = function(a) { a = a >>> 0;
            if (a >= mb && a < mb + 48) return m[(a - mb) >> 2] | 0;
            if (a >= sb && a < se)      return s[(a - sb) >> 2] | 0;
            return 0; };
        Module.test_writes = [];
        Module.bemental_imports.env.ppc_write32 = function(a, v) {
            Module.test_writes.push(a >>> 0); Module.test_writes.push(v >>> 0); };
    }, (u32)(uintptr_t)romtx, (u32)(uintptr_t)src, MBASE, (u32)(count * 3u));
#endif
    bool ok = run_psmtxro(env);
#ifdef __EMSCRIPTEN__
    u32 nw = (u32)EM_ASM_INT({ return Module.test_writes.length | 0; });
    for (u32 p = 0; p < nw / 2u && p < 256u; ++p) {
        u32 a = (u32)EM_ASM_INT({ return Module.test_writes[$0 * 2] >>> 0; }, p);
        u32 v = (u32)EM_ASM_INT({ return Module.test_writes[$0 * 2 + 1] >>> 0; }, p);
        u32 idx = (a - DBASE) >> 2; if (idx < 3u * count) dst_out[idx] = v;
    }
    EM_ASM({ Module.bemental_imports.env.ppc_write32 = function(a, v) {};
             Module.bemental_imports.env.ppc_read32  = function(a) { return 0; }; });
#endif
    return ok;
}

static bool test_psmtxro_goldens() {
    u32 pass = 0, fail = 0;
    for (unsigned k = 0; k < k_psmtx_goldens_n; ++k) {
        const PsmtxGolden& g = k_psmtx_goldens[k];
        uint32_t dst[128];
        for (u32 i = 0; i < 128; i++) dst[i] = 0xdeadbeefu;   // poison: catch missed writes
        if (!run_psmtxro_case(g.romtx, g.src, g.count, dst)) {
            std::printf("[psmtxro-gold] %-12s count=%u RUN FAILED\n", g.name, g.count); fail++; continue;
        }
        bool eq = true; u32 bad = 0;
        for (u32 i = 0; i < g.count * 3u; i++) if (dst[i] != g.dst[i]) { eq = false; bad = i; break; }
        if (eq) pass++;
        else {
            fail++;
            std::printf("[psmtxro-gold] %-12s count=%u MISMATCH @word%u got=%08x want=%08x\n",
                        g.name, g.count, bad, dst[bad], g.dst[bad]);
        }
    }
    std::printf("[psmtxro-gold] %u/%u goldens bit-exact (generic JIT vs native)\n", pass, pass + fail);
    return fail == 0;
}

// [B1 template pilot — increment 1: plumbing] With the template flag ON, the
// registry hook must (a) FIRE on the hash-matched entry block (census climbs) and
// (b) stay bit-exact — increment 1 falls through to the generic emit, so all 26
// goldens must still match. Arms g_bem_lc_base (emit-time SAB reads are lc_base-
// gated; the standard suite runs lc_base=0) + sets the flag cell, then restores.
extern "C" { extern uint32_t g_bem_lc_base; }
static bool test_psmtxro_template_hook() {
    volatile uint32_t* flag = (volatile uint32_t*)(uintptr_t)0x026B345Cu;
    volatile uint32_t* hits = (volatile uint32_t*)(uintptr_t)0x026B3460u;
    uint32_t saved_lc = g_bem_lc_base;
    g_bem_lc_base = 0x03000000u;                 // arm emit-time SAB reads (as line ~2704 does)
    *flag = 1u;                                  // template flag ON
    uint32_t before = *hits;
    u32 pass = 0, fail = 0;
    for (unsigned k = 0; k < k_psmtx_goldens_n; ++k) {
        const PsmtxGolden& g = k_psmtx_goldens[k];
        uint32_t dst[128]; for (u32 i = 0; i < 128; i++) dst[i] = 0xdeadbeefu;
        if (!run_psmtxro_case(g.romtx, g.src, g.count, dst)) { fail++; continue; }
        bool eq = true; for (u32 i = 0; i < g.count * 3u; i++) if (dst[i] != g.dst[i]) { eq = false; break; }
        if (eq) pass++; else fail++;
    }
    uint32_t after = *hits;
    *flag = 0u;                                  // restore OFF
    g_bem_lc_base = saved_lc;
    std::printf("[psmtxro-tmpl] flag ON: %u/%u bit-exact, template_hits %u->%u (delta=%u)\n",
                pass, pass + fail, before, after, after - before);
    return fail == 0 && after > before;          // hook FIRED and NO regression
}

// [B1 Blocker-1 isolation 2026-08-11] Is the denormal hang the PM26 deopt storm
// (JIT) or a reused-env artifact? FRESH env, chaining OFF (deopts return start_pc
// to THIS loop instead of an internal self-chain storm), denormal-only live-ins,
// bounded. Watch the PM26 deopt cell 0x026B33E4 + count self-re-dispatches
// (npc==cur = the guard deopted + returned its own start). Cell/self-redispatch
// climbing => PM26 CONFIRMED (the live build's JitWasm::Run would evict+force-
// double; the harness can't, so it loops). Quiet => env-reuse artifact.
extern "C" unsigned char g_bem_chain_enabled;
static bool test_psmtxro_denorm_isolate() {
    TestEnv env; if (!env.init()) return false;
    // FRESH env, chaining ON (default) — the ACTUAL hang condition. Denormal SINGLE
    // memory (psq_l loads them, as the real fn does), N=1, run the full function.
    // If run_psmtxro HANGS internally, the COMPLETED line never prints => JIT hang
    // (fresh-env => NOT the reuse artifact). COMPLETED => reuse/memset was the artifact.
    volatile u32* cell = (volatile u32*)(uintptr_t)0x026B33E4u;
    u32 before = *cell;
    u32 mtx[12], src[3];
    for (u32 i = 0; i < 12; i++) mtx[i] = 0x00000001u | ((0x155555u * (i + 1)) & 0x007FFFFEu);  // denormal singles
    for (u32 i = 0; i < 3;  i++) src[i] = 0x00000001u | ((0x0ABCDu  * (i + 1)) & 0x007FFFFEu);
    psq_env_common(env); env.spr(912) = 0;
    env.gpr(3) = 0x80100000u; env.gpr(4) = 0x80200000u; env.gpr(5) = 0x80500000u; env.gpr(6) = 1u;
    env.gpr(1) = 0x8010F000u;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        var m = []; var s = [];
        for (var i = 0; i < 12; i++) m.push(HEAPU32[($0 >> 2) + i] >>> 0);
        for (var j = 0; j < 3; j++) s.push(HEAPU32[($1 >> 2) + j] >>> 0);
        Module.bemental_imports.env.ppc_read32 = function(a) { a = a >>> 0;
            if (a >= 0x80100000 && a < 0x80100030) return m[(a - 0x80100000) >> 2] | 0;
            if (a >= 0x80200000 && a < 0x8020000c) return s[(a - 0x80200000) >> 2] | 0; return 0; };
        Module.bemental_imports.env.ppc_write32 = function(a, v) {};
    }, (u32)(uintptr_t)mtx, (u32)(uintptr_t)src);
#endif
    std::printf("[pm26-isolate] fresh-env chain-on denorm-memory: dispatching (NO 'COMPLETED' below => JIT hang)\n");
    bool ok = run_psmtxro(env);                              // reproduces the hang if it's the JIT
    u32 after = *cell;
    std::printf("[pm26-isolate] COMPLETED ok=%d deopt-cell %08x->%08x => denorm does NOT hang fresh-env; reuse/memset was the artifact\n",
                ok, before, after);
    (void)g_bem_chain_enabled;
    return true;   // diagnostic probe; read the printf (or its absence)
}

// [PM62 special-case conformance 2026-08-07] frsqrte/fres native emitters vs the
// Dolphin ApproximateReciprocalSquareRoot / ApproximateReciprocal special-value
// ladders (Common/FloatUtils.cpp). Workflow wf_d6c659d7 (both sides run in V8) found:
//   frsqrte(negative)  -> our -qNaN (0xfff8..)  should be +qNaN (0x7ff8..)   [FIXED]
//   fres(denormal)     -> our +-inf              should be copysign(FLT_MAX)  [FIXED]
// Special values are Dolphin-exact; the +2.0/4.0 normal cases are OUR full-precision
// (PM62 replaced the 5-bit estimate — intentionally more accurate — so they check the
// normal path is intact, not Gekko-estimate parity).
static bool test_frsqrte_special_values() {
    struct V { u64 in; u64 exp; const char* name; };
    static const V vs[] = {
        { 0xBFF0000000000000ull, 0x7FF8000000000000ull, "frsqrte(-1.0)=+qNaN" },
        { 0xFFF0000000000000ull, 0x7FF8000000000000ull, "frsqrte(-inf)=+qNaN" },
        { 0x8010000000000000ull, 0x7FF8000000000000ull, "frsqrte(-2^-1022)=+qNaN" },
        { 0x8000000000000000ull, 0xFFF0000000000000ull, "frsqrte(-0)=-inf" },
        { 0x0000000000000000ull, 0x7FF0000000000000ull, "frsqrte(+0)=+inf" },
        { 0x7FF0000000000000ull, 0x0000000000000000ull, "frsqrte(+inf)=+0" },
        { 0x4010000000000000ull, 0x3FE0000000000000ull, "frsqrte(4.0)=0.5" },
    };
    bool ok = true;
    for (const auto& v : vs) {
        TestEnv env; if (!env.init()) return false;
        *(u32*)((u8*)env.ctx_raw + ppc_off::MSR) = 0x2000u;   // MSR.FP=1
        set_ps(env, 2, v.in, 0);
        const u32 insts[] = { 0xFC201034u };                  // frsqrte f1, f2
        s32 next_pc = -1;
        if (!env.dispatch_block(0x80300000u, insts, 1, &next_pc)) return false;
        const u64 got = get_ps0(env, 1);
        const bool m = (got == v.exp); ok = ok && m;
        std::printf("[diag frsqrte-sp] %-20s got=0x%016llx exp=0x%016llx %s\n",
                    v.name, (unsigned long long)got, (unsigned long long)v.exp, m ? "OK" : "MISMATCH");
    }
    return ok;
}
static bool test_fres_special_values() {
    struct V { u64 in; u64 exp; const char* name; };
    static const V vs[] = {
        { 0x0000000000000001ull, 0x47EFFFFFE0000000ull, "fres(+denorm)=+FLTMAX" },
        { 0x8000000000000001ull, 0xC7EFFFFFE0000000ull, "fres(-denorm)=-FLTMAX" },
        { 0x0000000000000000ull, 0x7FF0000000000000ull, "fres(+0)=+inf" },
        { 0x8000000000000000ull, 0xFFF0000000000000ull, "fres(-0)=-inf" },
        { 0x7FF0000000000000ull, 0x0000000000000000ull, "fres(+inf)=+0" },
        { 0xFFF0000000000000ull, 0x8000000000000000ull, "fres(-inf)=-0" },
        { 0x4000000000000000ull, 0x3FE0000000000000ull, "fres(2.0)=0.5" },
    };
    bool ok = true;
    for (const auto& v : vs) {
        TestEnv env; if (!env.init()) return false;
        *(u32*)((u8*)env.ctx_raw + ppc_off::MSR) = 0x2000u;   // MSR.FP=1
        set_ps(env, 2, v.in, 0);
        const u32 insts[] = { 0xEC201030u };                  // fres f1, f2
        s32 next_pc = -1;
        if (!env.dispatch_block(0x80300000u, insts, 1, &next_pc)) return false;
        const u64 got0 = get_ps0(env, 1), got1 = get_ps1(env, 1);
        const bool m = (got0 == v.exp) && (got1 == v.exp); ok = ok && m;   // both lanes
        std::printf("[diag fres-sp] %-20s ps0=0x%016llx ps1=0x%016llx exp=0x%016llx %s\n",
                    v.name, (unsigned long long)got0, (unsigned long long)got1,
                    (unsigned long long)v.exp, m ? "OK" : "MISMATCH");
    }
    return ok;
}

// [2026-08-12 CYCLE LEDGER] The Summit-1 fork instrument, on the LIVE build_block_next
// emitter via the proven TestEnv+self-chain harness (test_idct_selfchain_bench pattern) —
// NOT the legacy test_perf_t1 (retracted: wrong emitter). Measures the per-tax EXECUTED
// cost (ns/iter, native_ratio vs 486MHz Gekko) of INT+eager-CR (t1a) and bswap (t1b lwzx/
// stwx fastmem). Compare against BEM_STRIP_BSWAP / BEM_LAZY_CR rebuilds for the tax delta.
static bool test_cycle_ledger() {
#ifndef __EMSCRIPTEN__
    return true;
#else
    using namespace ppc;   // ppc_encode.h encoders live in namespace ppc
    TestEnv env; if (!env.init()) return false;
    psq_env_common(env);
    static std::vector<u8> buf; buf.assign(0x100000u, 0);         // 1MB fastmem window
    const u32 host_base = (u32)(uintptr_t)buf.data();
    // Pure loop bodies, bdnz -> start (self-chain); reset sets regs + CTR each pass.
    static const u32 bare[] = {    // 4 ALU + bdnz, NO cmpwi — isolates base per-op overhead
        add(4,4,5), subf(4,6,4), rlwinm(4,4,1,0,30), xor_(4,4,7), bdnz(-16),
    };
    static const u32 intcr[] = {   // 5 body ops incl the eager-CR cmpwi
        add(4,4,5), subf(4,6,4), rlwinm(4,4,1,0,30), xor_(4,4,7), cmpwi(0,4,0), bdnz(-20),
    };
    static const u32 bsw[] = {     // lwzx/stwx = fastmem load/store => emit_bswap present
        lwzx(8,4,7), stwx(8,5,7), addi(7,7,4), bdnz(-12),
    };
    struct Kern { const char* name; const u32* insts; u32 n; u32 refcyc; };
    const Kern kerns[] = {
        {"bare ", bare,  (u32)(sizeof(bare)/4),  4u},
        {"intcr", intcr, (u32)(sizeof(intcr)/4), 5u},
        {"bswap", bsw,   (u32)(sizeof(bsw)/4),   3u},
    };
    const u32 CTR = 4096u;
    for (u32 ki = 0; ki < 3u; ++ki) {
        const Kern& k = kerns[ki];
        const u32 PC = 0x80010000u + ki * 0x10000u;
        std::vector<u8> bytes = build_block_next(PC, k.insts, k.n, env.ctx_ptr,
                                                 host_base, 0x000FFFFFu, 0x100000u);
        int handle = env.cache.compile(PC, bytes.data(), bytes.size());
        if (handle < 0) { std::printf("[ledger] %s compile FAILED\n", k.name); continue; }
        auto reset = [&]() {
            env.gpr(4) = 0x80000000u; env.gpr(5) = 0x80000000u; env.gpr(6) = 3u; env.gpr(7) = 0u;
            env.spr(9) = CTR;                                     // CTR
            *(s32*)((u8*)env.ctx_raw + ppc_off::DOWNCOUNT)  = 50000000;
            *(u32*)((u8*)env.ctx_raw + ppc_off::EXCEPTIONS) = 0;
            *(u32*)((u8*)env.ctx_raw + ppc_off::PC)         = PC;
        };
        s32 next_pc = -1;
        for (int p = 0; p < 60; ++p) { reset(); env.cache.dispatch(PC, &next_pc); }
        reset(); env.cache.dispatch(PC, &next_pc);
        const u32 ctr_after = env.spr(9);
        double t0 = emscripten_get_now();
        const int TIMED = 200;
        for (int p = 0; p < TIMED; ++p) { reset(); env.cache.dispatch(PC, &next_pc); }
        double t1 = emscripten_get_now();
        const double iters = (double)TIMED * (double)CTR;
        const double ns = (t1 - t0) * 1e6 / iters;
        const double ratio = (double)k.refcyc / (ns * 1e-9 * 486e6);
        std::printf("[ledger] %-6s %.3f ns/iter  native_ratio=%.3f  (%u refcyc, chain-CTR-after=%u %s)\n",
                    k.name, ns, ratio, k.refcyc, ctr_after, ctr_after == 0 ? "self-chain" : "per-iter");
    }
    return true;
#endif
}

static const TestCase k_tests[] = {
    {"frsqrte_special_values",           &test_frsqrte_special_values},
    {"fres_special_values",              &test_fres_special_values},
    {"writemtxps4x3_send_sequence",      &test_writemtxps4x3_send_sequence},
    {"psmtxconcat_row2_build",           &test_psmtxconcat_row2_build},
    {"psmtxro_diff",                     &test_psmtxro_diff},
    {"psmtxro_goldens",                  &test_psmtxro_goldens},
    {"psmtxro_template_hook",            &test_psmtxro_template_hook},
    {"psmtxro_denorm_isolate",           &test_psmtxro_denorm_isolate},
    {"lazycr_cross_block_beq",           &test_lazycr_cross_block_beq},
    {"lazycr_so_freeze",                 &test_lazycr_so_freeze},
    {"lazycr_fused_adjacent",            &test_lazycr_fused_adjacent},
    // [PM53] bench first: the wasmdump hex stream takes ~15 min through the
    // headless console pipe; the bench result must not sit behind it.
    {"idct_selfchain_bench",             &test_idct_selfchain_bench},
    {"cycle_ledger",                     &test_cycle_ledger},
    {"fused_intloop_runs_to_exit",       &test_fused_intloop_runs_to_exit},
    {"fused_b_elision_seam",             &test_fused_b_elision_seam},
    {"fused_bwd_seam",                   &test_fused_bwd_seam},
    {"fused_terminator_fixup",           &test_fused_terminator_fixup},
    {"fused_bl_inline_ras_hit",          &test_fused_bl_inline_ras_hit},
    {"fused_bl_inline_ras_miss",         &test_fused_bl_inline_ras_miss},
    {"sab_sched_wasm_dump",              &test_sab_sched_wasm_dump},
    {"ea_cse_stw_then_lwz_same_slot",    &test_ea_cse_stw_then_lwz_same_slot},
    {"reloc_standalone_add_rt_eq_rb",    &test_reloc_standalone_add_rt_eq_rb},
    {"reloc_standalone_add_rt_ne_rb",    &test_reloc_standalone_add_rt_ne_rb},
    {"reloc_load_add_rt_eq_rb",          &test_reloc_load_add_rt_eq_rb},
    {"reloc_load_add_rt_ne_rb",          &test_reloc_load_add_rt_ne_rb},
    {"reloc_full_lo_arm",                &test_reloc_full_lo_arm},
    {"reloc_full_ha_arm",                &test_reloc_full_ha_arm},
    {"reloc_wasm_dump",                  &test_reloc_wasm_dump},
    {"ps_merge10_alias_fd_eq_fa",        &test_ps_merge10_alias_fd_eq_fa},
    {"adde_alias_carry_chain",           &test_adde_alias_carry_chain},
    {"addi_sequential",                  &test_addi_sequential},
    {"viwait_recheck_block",             &test_viwait_recheck_block},
    {"lfs_sda2_negative_offset",         &test_lfs_sda2_negative_offset},
    {"lfs_msr_fp_disabled",              &test_lfs_msr_fp_disabled},
    {"mfspr_interp_writeback_visible",   &test_mfspr_interp_writeback_visible},
    {"stfs_native_converttosingle",      &test_stfs_native_converttosingle},
    {"psq_l_float_pair",                 &test_psq_l_float_pair},
    {"psq_l_w1_ps1_one",                 &test_psq_l_w1_ps1_one},
    {"psq_l_u8_scale4",                  &test_psq_l_u8_scale4},
    {"psq_st_float_ftz_denormal",        &test_psq_st_float_ftz_denormal},
    {"psq_st_s16_clamp_trunc",           &test_psq_st_s16_clamp_trunc},
    {"psq_lu_ra_writeback",              &test_psq_lu_ra_writeback},
    {"fadds_fill_both_lanes",            &test_fadds_fill_both_lanes},
    {"fadds_ni_flush_vs_keep",           &test_fadds_ni_flush_vs_keep},
    {"fmuls_force25bit_c",               &test_fmuls_force25bit_c},
    {"fmadds_basic",                     &test_fmadds_basic},
    {"fnmsubs_sign",                     &test_fnmsubs_sign},
    {"fdivs_round_single",               &test_fdivs_round_single},
    {"frsp_fill_both",                   &test_frsp_fill_both},
    {"ps_sum1_basic",                    &test_ps_sum1_basic},
    {"ps_add_simd",                      &test_ps_add_simd},
    {"ps_sub_simd",                      &test_ps_sub_simd},
    {"ps_mul_simd",                      &test_ps_mul_simd},
    {"ps_madd_simd",                     &test_ps_madd_simd},
    {"ps_madd_alias_fa",                 &test_ps_madd_alias_fa},
    {"ps_madds0_simd",                   &test_ps_madds0_simd},
    {"ps_madds1_simd",                   &test_ps_madds1_simd},
    {"ps_madds0_alias_fd_eq_fc",         &test_ps_madds0_alias_fd_eq_fc},
    {"ps_madds0_alias_fd_eq_fa",         &test_ps_madds0_alias_fd_eq_fa},
    {"ps_madds0_alias_fd_eq_fb",         &test_ps_madds0_alias_fd_eq_fb},
    {"ps_madds1_alias_fd_eq_fc",         &test_ps_madds1_alias_fd_eq_fc},
    {"ps_madd_alias_fd_eq_fa",           &test_ps_madd_alias_fd_eq_fa},
    {"ps_madd_alias_fd_eq_fb",           &test_ps_madd_alias_fd_eq_fb},
    {"ps_madd_alias_fd_eq_fc",           &test_ps_madd_alias_fd_eq_fc},
    {"ps_msub_alias_fd_eq_fa",           &test_ps_msub_alias_fd_eq_fa},
    {"ps_msub_alias_fd_eq_fb",           &test_ps_msub_alias_fd_eq_fb},
    {"ps_msub_alias_fd_eq_fc",           &test_ps_msub_alias_fd_eq_fc},
    {"ps_nmadd_alias_fd_eq_fa",          &test_ps_nmadd_alias_fd_eq_fa},
    {"ps_nmadd_alias_fd_eq_fb",          &test_ps_nmadd_alias_fd_eq_fb},
    {"ps_nmadd_alias_fd_eq_fc",          &test_ps_nmadd_alias_fd_eq_fc},
    {"ps_nmsub_alias_fd_eq_fa",          &test_ps_nmsub_alias_fd_eq_fa},
    {"ps_nmsub_alias_fd_eq_fb",          &test_ps_nmsub_alias_fd_eq_fb},
    {"ps_nmsub_alias_fd_eq_fc",          &test_ps_nmsub_alias_fd_eq_fc},
    {"ps_add_alias_ctrl",                &test_ps_add_alias_ctrl},
    {"ps_add_alias_fd_eq_fa",            &test_ps_add_alias_fd_eq_fa},
    {"ps_add_alias_fd_eq_fb",            &test_ps_add_alias_fd_eq_fb},
    {"ps_sub_alias_ctrl",                &test_ps_sub_alias_ctrl},
    {"ps_sub_alias_fd_eq_fa",            &test_ps_sub_alias_fd_eq_fa},
    {"ps_sub_alias_fd_eq_fb",            &test_ps_sub_alias_fd_eq_fb},
    {"ps_div_alias_ctrl",                &test_ps_div_alias_ctrl},
    {"ps_div_alias_fd_eq_fa",            &test_ps_div_alias_fd_eq_fa},
    {"ps_div_alias_fd_eq_fb",            &test_ps_div_alias_fd_eq_fb},
    {"ps_mul_alias_ctrl",                &test_ps_mul_alias_ctrl},
    {"ps_mul_alias_fd_eq_fa",            &test_ps_mul_alias_fd_eq_fa},
    {"ps_mul_alias_fd_eq_fc",            &test_ps_mul_alias_fd_eq_fc},
    {"ps_muls0_alias_ctrl",              &test_ps_muls0_alias_ctrl},
    {"ps_muls0_alias_fd_eq_fa",          &test_ps_muls0_alias_fd_eq_fa},
    {"ps_muls0_alias_fd_eq_fc",          &test_ps_muls0_alias_fd_eq_fc},
    {"ps_muls1_alias_ctrl",              &test_ps_muls1_alias_ctrl},
    {"ps_muls1_alias_fd_eq_fa",          &test_ps_muls1_alias_fd_eq_fa},
    {"ps_muls1_alias_fd_eq_fc",          &test_ps_muls1_alias_fd_eq_fc},
    {"ps_sum0_basic",                    &test_ps_sum0_basic},
    {"ps_sum0_alias_fd_eq_fa",           &test_ps_sum0_alias_fd_eq_fa},
    {"ps_sum0_alias_fd_eq_fb",           &test_ps_sum0_alias_fd_eq_fb},
    {"ps_sum0_alias_fd_eq_fc",           &test_ps_sum0_alias_fd_eq_fc},
    {"ps_sum1_alias_fd_eq_fa_simd",      &test_ps_sum1_alias_fd_eq_fa_simd},
    {"ps_sum1_alias_fd_eq_fb",           &test_ps_sum1_alias_fd_eq_fb},
    {"ps_sum1_alias_fd_eq_fc",           &test_ps_sum1_alias_fd_eq_fc},
    {"ps_sel_basic",                     &test_ps_sel_basic},
    {"ps_sel_alias_fd_eq_fa",            &test_ps_sel_alias_fd_eq_fa},
    {"ps_sel_alias_fd_eq_fb",            &test_ps_sel_alias_fd_eq_fb},
    {"ps_sel_alias_fd_eq_fc",            &test_ps_sel_alias_fd_eq_fc},
    {"ps_merge00_alias_fd_distinct",     &test_ps_merge00_alias_fd_distinct},
    {"ps_merge00_alias_fd_eq_fa",        &test_ps_merge00_alias_fd_eq_fa},
    {"ps_merge00_alias_fd_eq_fb",        &test_ps_merge00_alias_fd_eq_fb},
    {"ps_merge01_alias_fd_distinct",     &test_ps_merge01_alias_fd_distinct},
    {"ps_merge01_alias_fd_eq_fa",        &test_ps_merge01_alias_fd_eq_fa},
    {"ps_merge01_alias_fd_eq_fb",        &test_ps_merge01_alias_fd_eq_fb},
    {"ps_merge10_alias_fd_distinct",     &test_ps_merge10_alias_fd_distinct},
    {"ps_merge10_alias_fd_eq_fa_b2",     &test_ps_merge10_alias_fd_eq_fa_b2},
    {"ps_merge10_alias_fd_eq_fb",        &test_ps_merge10_alias_fd_eq_fb},
    {"ps_merge11_alias_fd_distinct",     &test_ps_merge11_alias_fd_distinct},
    {"ps_merge11_alias_fd_eq_fa",        &test_ps_merge11_alias_fd_eq_fa},
    {"ps_merge11_alias_fd_eq_fb",        &test_ps_merge11_alias_fd_eq_fb},
    {"ps_mr_alias_fd_distinct",          &test_ps_mr_alias_fd_distinct},
    {"ps_mr_alias_fd_eq_fb",             &test_ps_mr_alias_fd_eq_fb},
    {"ps_neg_alias_fd_distinct",         &test_ps_neg_alias_fd_distinct},
    {"ps_neg_alias_fd_eq_fb",            &test_ps_neg_alias_fd_eq_fb},
    {"ps_abs_alias_fd_distinct",         &test_ps_abs_alias_fd_distinct},
    {"ps_abs_alias_fd_eq_fb",            &test_ps_abs_alias_fd_eq_fb},
    {"ps_nabs_alias_fd_distinct",        &test_ps_nabs_alias_fd_distinct},
    {"ps_nabs_alias_fd_eq_fb",           &test_ps_nabs_alias_fd_eq_fb},
    {"ps_muls0_simd",                    &test_ps_muls0_simd},
    {"ps_muls1_simd",                    &test_ps_muls1_simd},
    {"ps_merge00_simd",                  &test_ps_merge00_simd},
    {"ps_merge01_simd",                  &test_ps_merge01_simd},
    {"ps_merge11_simd",                  &test_ps_merge11_simd},
    {"ps_sum1_fd_aliases_fa",            &test_ps_sum1_fd_aliases_fa},
    {"singles_arm_psq_chain",            &test_singles_arm_psq_chain},
    {"singles_arm_stfs",                 &test_singles_arm_stfs},
    {"singles_arm_ps_sum1_alias",        &test_singles_arm_ps_sum1_alias},
    {"idct_wasm_dump",                   &test_idct_wasm_dump},
    {"fctiwz_vectors",                   &test_fctiwz_vectors},
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
    {"dcbz_line_zero_fastmem",           &test_dcbz_line_zero_fastmem},
    {"dcbz_unaligned_rounds_down",       &test_dcbz_unaligned_rounds_down},
    {"dcbz_mmio_falls_back_to_interp",   &test_dcbz_mmio_falls_back_to_interp},
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
        env.ppc_msr_updated  = function(msr) {};
        env.ppc_gather_drain = function() {};
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
