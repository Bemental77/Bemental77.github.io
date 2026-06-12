#pragma once
//
// T1 microkernel corpus for bementalJIT performance measurement.
//
// Each kernel is a self-contained PowerPC code blob with:
//   - inner_count: how many guest "iterations" one kernel invocation does.
//   - ref_cycles_per_iter: cycles on real Gekko (CPU 486 MHz) PER iter.
//     Treat as the reference unit; native_ratio = (calls * inner_count *
//     ref_cycles_per_iter) / (wall_seconds * 486_000_000).
//
// Gekko (Broadway-derived 750CL) cycle facts used to derive ref values
// — IBM PowerPC 750CL User Manual + Gekko-specific addenda:
//   Integer ALU (add/sub/and/or/xor/cmp/rlwinm): 1-cycle latency,
//     dual-issue (IU1 + IU2), 2 ops/cycle peak throughput.
//   lwz / lwzx / lbz / lbzx (L1 hit):     2-cycle latency, 1/cycle issue.
//   stw / stwx:                            1-cycle issue, store-commits
//                                          don't block successors.
//   mullw:                                 4-cycle latency, 1/cycle issue.
//   bdnz/bc (predicted taken):             1 cycle, often dual-issues.
//   bl:                                    1 cycle (writes LR).
//   blr (BHT hit on link stack):           1 cycle.
//   mflr / mtlr (SPR access):              2 cycles each.
//   lfs / stfs:                            2-cycle latency, 1/cycle issue.
//   fmuls / fadds / fmadds:                5-cycle latency, 1/cycle pipelined.
//   fctiwx:                                5-cycle latency.
//
// Dependency-chain serialization usually dominates over peak throughput
// for these kernels, so per-iter cycle counts reflect the critical path.
//
// Calling convention (matches PowerPC ABI):
//   - r3 = inner iteration count, set by harness before each invocation
//   - r1 = stack pointer (set up by harness, points into MEM1 stack region)
//   - lr = return address (harness sets to a parking PC the dispatcher
//     recognises as kernel-done)
//   - all other regs are scratch
//
// Memory layout (harness-controlled MEM1 image):
//   0x80003000 — T1a kernel base
//   0x80003800 — T1b kernel base
//   0x80004000 — T1c kernel base
//   0x80004800 — T1d kernel base
//   0x80005000 — T1e kernel base
//   0x80100000 — scratch buffer for T1b memcpy / T1e hash input
//   0x80200000 — destination / sentinel page
//   0x80300000 — stack top (grows down)

#include "ppc_encode.h"

namespace bemental::perf {

using namespace ::ppc;

struct T1Kernel {
    const char* id;             // "t1a" .. "t1e"
    const char* description;
    u32         load_pc;        // where harness loads kernel into guest mem
    const u32*  insts;
    u32         inst_count;
    u32         inner_count;    // value loaded into r3 before invocation
    u32         ref_cycles_per_iter;  // PROVISIONAL — see Task #24
};

// ---------- T1a: Integer Dhrystone-style -----------------------------------
// Inner body: add / subf / rlwinm / xor / cmpwi / bdnz — 6 ops per iter.
//
// Cycle derivation: r4 carries a serial dependency chain
// (add → subf → rlwinm → xor → cmpwi). Each link is 1-cycle ALU, so the
// critical path is 5 cycles. bdnz reads CTR (not cr0), so it dual-issues
// with cmpwi for an effective 5 cycles/iter on Gekko's 2-issue front-end.
// We use 5 (was 6 — the dual-issue of bdnz lops one cycle off the naive
// count).
static const u32 t1a_insts[] = {
    // Setup
    li(4, 0),                            // r4 = 0
    li(5, 7),                            // r5 = 7
    li(6, 3),                            // r6 = 3
    li(7, 0x55),                         // r7 = 0x55
    mtctr(3),                            // CTR = r3 (iteration count)
    // Loop body (offset = 5 instr * 4 = 20 from start, which is +0 from this point)
    add(4, 4, 5),                        // r4 += r5
    subf(4, 6, 4),                       // r4 = r4 - r6
    rlwinm(4, 4, 1, 0, 30),              // r4 = (r4 << 1) & ~1
    xor_(4, 4, 7),                       // r4 ^= r7
    cmpwi(0, 4, 0),                      // cmp cr0, r4, 0
    bdnz(-20),                           // branch back 5 instr (4 bytes each)
    // Done
    blr(),
};
static const T1Kernel T1a = {
    "t1a",
    "integer Dhrystone-style (6-op loop)",
    /*load_pc=*/0x80003000,
    t1a_insts,
    /*inst_count=*/sizeof(t1a_insts) / sizeof(u32),
    /*inner_count=*/100000,
    /*ref_cycles_per_iter=*/5,
};

// ---------- T1b: memcpy 4 KiB (1024 words) ---------------------------------
// Tight lwzx/stwx loop, exercises fastmem `lwz`/`stw` emit + bdnz.
//
// Cycle derivation: lwzx (2-cycle) → stwx must wait for r8 → stwx issues at
// cycle 2; addi (independent) dual-issues with stwx; bdnz dual-issues with
// addi. Critical path = lwzx 2 + stwx 1 = 3 cycles/iter when r5/r4 stay in
// L1 D-cache. Loop carries no register dep chain across iterations.
static const u32 t1b_insts[] = {
    lis(4, 0x8010),                      // r4 = src base = 0x80100000
    lis(5, 0x8020),                      // r5 = dst base = 0x80200000
    mtctr(3),                            // CTR = r3 (word count, harness sets 1024)
    li(7, 0),                            // r7 = offset = 0
    // Loop
    lwzx(8, 4, 7),                       // r8 = mem[r4 + r7]
    stwx(8, 5, 7),                       // mem[r5 + r7] = r8
    addi(7, 7, 4),                       // r7 += 4
    bdnz(-12),                           // branch back 3 instr
    blr(),
};
static const T1Kernel T1b = {
    "t1b",
    "memcpy 4 KiB (lwzx/stwx tight loop)",
    /*load_pc=*/0x80003800,
    t1b_insts,
    /*inst_count=*/sizeof(t1b_insts) / sizeof(u32),
    /*inner_count=*/1024,
    /*ref_cycles_per_iter=*/3,
};

// ---------- T1c: 4×4 matrix-vec multiply (dot-product loop) ----------------
// Per outer iter: 6 lfs, 2 fmuls, 2 fmadds, 1 fadds, 1 stfs, 1 bdnz.
//
// Cycle derivation (critical path):
//   lfs f0 (cycle 0..2) … lfs f5 issued back-to-back, last result ready at
//     cycle 7 (6 loads × 1/cycle, 2-cycle latency on the last).
//   fmuls f6 = f0*f4 — both ready by cycle 5; issues cycle 5, ready cycle 10.
//   fmadds f6 = f1*f5 + f6 — depends on fmuls f6, ready cycle 15.
//   fmuls f7 / fmadds f7 chain runs in parallel, ready cycle 15.
//   fadds f8 = f6 + f7 — ready cycle 20.
//   stfs f8 — issues cycle 20, commits cycle 22.
//   bdnz dual-issues.
// The 5-cycle FP latency dominates the chain. Total ~20 cycles/iter.
static const u32 t1c_insts[] = {
    lis(4, 0x8010),                      // vec base
    lis(5, 0x8020),                      // mat base (we'll just reuse same row)
    lis(6, 0x8030),                      // out base
    mtctr(3),                            // outer count
    // Loop body
    lfs(0, 4, 0),                        // f0 = vec[0]
    lfs(1, 4, 4),                        // f1 = vec[1]
    lfs(2, 4, 8),                        // f2 = vec[2]
    lfs(3, 4, 12),                       // f3 = vec[3]
    lfs(4, 5, 0),                        // f4 = mat[0]
    lfs(5, 5, 4),                        // f5 = mat[1]
    fmuls(6, 0, 4),                      // f6 = f0 * f4
    fmadds(6, 1, 5, 6),                  // f6 = f1 * f5 + f6
    fmuls(7, 2, 4),                      // f7 = f2 * f4
    fmadds(7, 3, 5, 7),                  // f7 = f3 * f5 + f7
    fadds(8, 6, 7),                      // f8 = f6 + f7
    stfs(8, 6, 0),                       // out[0] = f8
    bdnz(-12 * 4),                       // branch back 12 instr
    blr(),
};
static const T1Kernel T1c = {
    "t1c",
    "4x4 mat-vec FP dot product",
    /*load_pc=*/0x80004000,
    t1c_insts,
    /*inst_count=*/sizeof(t1c_insts) / sizeof(u32),
    /*inner_count=*/10000,
    /*ref_cycles_per_iter=*/20,
};

// ---------- T1d: Fibonacci(25) recursive -----------------------------------
// Stresses bl/blr block linking, mflr/mtlr, stack discipline. Each call
// site emits a separate block in JIT — block-link patching effectiveness
// dominates.
//
// Call count: T(n) = 2*Fib(n+1) - 1 calls for naive fib(n).
//   Fib(26) = 121393 → T(25) = 242,785 total calls.
//
// Cycle derivation per call (recursive arm, 16-instruction body):
//   cmpwi+blt-not-taken: 2 cycles (blt's redirect adds nothing if predicted)
//   mflr: 2 cycles
//   stw r0+r3: 2 cycles (back-to-back stores, 1/cycle)
//   addi+bl: bl has 1-cycle issue but pipeline-flush penalty on link → ~3
//   stw r3 (after-call): 1
//   lwz+addi+bl: 4
//   lwz r4: 1
//   add: 1
//   lwz r0: 1
//   mtlr: 2
//   blr: 1 (link-stack hit)
//   = ~20 cycles/call on the recursive arm.
// Base case (cmpwi+blt+blr): ~3 cycles. Mix is dominated by recursive
// arm. Use 18 cycles/call average. Total fib(25) ~= 242785 * 18 = 4.37M
// cycles. The harness multiplies inner_count (=25) by ref_cycles_per_iter,
// so set ref_cycles_per_iter = 4_370_130 / 25 = 174_805.
// Layout (each line = 1 instruction; offset in bytes). Each recursive call
// allocates a fresh 32-byte stack frame via `stwu r1, -32(r1)`; without it,
// nested calls would stomp the parent's saved LR/n at fixed r1+offsets.
//   0   cmpwi r3, 2
//   4   blt   base_case   (target offset 76 → disp +72)
//   8   stwu  r1, -32(r1)  (alloc frame, store back-pointer at new r1)
//  12   mflr  r0
//  16   stw   r0, 28(r1)
//  20   stw   r3, 24(r1)
//  24   addi  r3, r3, -1
//  28   bl    entry        (disp -28)
//  32   stw   r3, 20(r1)
//  36   lwz   r3, 24(r1)
//  40   addi  r3, r3, -2
//  44   bl    entry        (disp -44)
//  48   lwz   r4, 20(r1)
//  52   add   r3, r3, r4
//  56   lwz   r0, 28(r1)
//  60   mtlr  r0
//  64   addi  r1, r1, 32   (dealloc frame)
//  68   blr
//  72   <reserved>          (no-op nop slot for alignment, never executed)
//  76   blr   (base case — n<2: return n unchanged, lr untouched)
//
// stwu encoding: D-form opcode 37 (op 37 = 0x25). Same arg shape as stw.
static inline u32 stwu_d(u32 s, u32 a, s16 simm) {
    return d_form(37, s, a, static_cast<u16>(simm));
}
static const u32 t1d_insts[] = {
    cmpwi(0, 3, 2),                              // 0
    blt(72),                                     // 4   → base_case at 76
    stwu_d(1, 1, -32),                           // 8   alloc 32B frame
    mflr(0),                                     // 12
    stw(0, 1, 28),                               // 16
    stw(3, 1, 24),                               // 20
    addi(3, 3, -1),                              // 24
    b(-28, /*aa=*/false, /*lk=*/true),           // 28  → bl entry
    stw(3, 1, 20),                               // 32
    lwz(3, 1, 24),                               // 36
    addi(3, 3, -2),                              // 40
    b(-44, /*aa=*/false, /*lk=*/true),           // 44  → bl entry
    lwz(4, 1, 20),                               // 48
    add(3, 3, 4),                                // 52
    lwz(0, 1, 28),                               // 56
    mtlr(0),                                     // 60
    addi(1, 1, 32),                              // 64  dealloc frame
    blr(),                                       // 68
    or_(0, 0, 0),                                // 72  nop (or r0,r0,r0)
    blr(),                                       // 76  base_case
};
static const T1Kernel T1d = {
    "t1d",
    "fib(25) recursive — stresses block linking",
    /*load_pc=*/0x80004800,
    t1d_insts,
    /*inst_count=*/sizeof(t1d_insts) / sizeof(u32),
    /*inner_count=*/25,        // harness invokes fib(25) once per call
    /*ref_cycles_per_iter=*/174805u,  // 4.37M cycles total / inner_count(25)
};

// ---------- T1e: FNV-1a hash over 1 MiB ------------------------------------
// Per byte: lbzx + xor + mullw + addi + bdnz.
//
// Cycle derivation: hash carries a tight dependency chain across iterations:
//   prev_iter.mullw → this_iter.xor → this_iter.mullw → next_iter.xor.
//   mullw is 4-cycle latency, fully pipelined. The chain length per iter
//   in critical-path terms is dominated by the mullw 4-cycle latency
//   (xor is 1-cycle and can issue at cycle 5, mullw issues at cycle 6
//   completes cycle 10, next_iter.xor issues cycle 11).
//   addi+bdnz dual-issue with the hash work.
// Steady-state ~5 cycles/iter once pipelined.
static const u32 t1e_insts[] = {
    lis(4, 0x8010),                      // r4 = data base = 0x80100000
    mtctr(3),                            // CTR = byte count
    lis(6, 0x811c),                      // r6 = FNV-1a offset basis hi
    ori(6, 6, 0x9dc5),                   // r6 |= 0x9dc5  -> 0x811c9dc5
    li(7, 1),                            // r7 = 1
    rlwinm(7, 7, 24, 0, 7),              // r7 = 0x01000000
    ori(7, 7, 0x0193),                   // r7 |= 0x0193  -> 0x01000193 (FNV prime)
    li(8, 0),                            // r8 = offset
    // Loop (5 instructions; bdnz branches back 4 to lbzx)
    lbzx(9, 4, 8),                       // r9 = byte
    xor_(6, 6, 9),                       // hash ^= byte
    mullw(6, 6, 7),                      // hash *= prime
    addi(8, 8, 1),                       // offset++
    bdnz(-4 * 4),                        // back 4 instr to lbzx
    blr(),
};
static const T1Kernel T1e = {
    "t1e",
    "FNV-1a hash 1 MiB",
    /*load_pc=*/0x80005000,
    t1e_insts,
    /*inst_count=*/sizeof(t1e_insts) / sizeof(u32),
    /*inner_count=*/1048576,
    /*ref_cycles_per_iter=*/5,
};

static constexpr const T1Kernel* kAll[] = {&T1a, &T1b, &T1c, &T1d, &T1e};
static constexpr u32 kAllCount = sizeof(kAll) / sizeof(kAll[0]);

}  // namespace bemental::perf
