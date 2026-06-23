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

static const TestCase k_tests[] = {
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
