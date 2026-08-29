//
// jit_load_store.cpp — Phase 3 implementation. Guard-branch fastmem +
// MMIO-routed slow path. Replaces the live tree's path-(a)/(b)/(c) soup
// in emit_load_d / emit_store_d.
//
// Bug class closed structurally: the slow path is taken unconditionally
// for any EA outside MEM1's [base, base+ram_size) range — including MMIO
// addresses like 0xCC005000. No "trust the DFA" bypass.
//
// Emit shape per op (D-form load shown — store/X-form analogous):
//   compute EA -> LOCAL_TMP_EA
//   push fastmem-guard i32 to stack    (uses LOCAL_TMP_EA, stack-additive)
//   rc.Flush(ctx_ptr)                  (stack-neutral)
//   wb.op_if(BLOCK_TYPE_VOID)          (consumes the guard from stack)
//     ;; fast path
//     load (EA & mem1_mask) + mem1_base, byte-swap, write result to RT local
//   wb.op_else()
//     ;; slow path — MMIO routes here too
//     push EA, call WIMPORT_READ*, write result to RT local
//   wb.op_end()
//   rc invalidates immediate-tracking on op_end (structural fix for the
//   b11 coherence bug class).
//   if (update): write EA local back to RA via RegCache.Bind(ra, Write).

#include "jit_load_store.h"

#include "bementalJIT/region_desc.h"   // [AOT v4 reloc] BemRelocSym + sentinel
#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "common/op_info.h"
#include "fpr_reg_cache.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

// [psq-gqr-spec PM48] "big SAB present" gate + emit-time live-GQR read.
// Defined in block_cache.cpp; same pattern as jit_paired.cpp / fpr_reg_cache.cpp.
extern "C" { extern uint32_t g_bem_lc_base; }
// [gp-inwasm] runtime "a write-gather-pipe store is pending" flag (block_cache.cpp)
// + the offline-AOT reloc mode selector (a native tool's &g_bem_gp_dirty is a wild
// pointer in the worker). Same pair jit_branch.cpp externs for its exit drains.
extern "C" { extern int g_bem_gp_dirty; extern int g_bem_aot_reloc_mode; }

namespace bemental::powerpc {

static constexpr u8 BLOCK_TYPE_VOID = 0x40;

// Locked import indices (must match the live tree's gekko_emit.h enum).
static constexpr u32 WIMPORT_READ8   = 0;
static constexpr u32 WIMPORT_READ16  = 1;
static constexpr u32 WIMPORT_READ32  = 2;
static constexpr u32 WIMPORT_WRITE8  = 3;
static constexpr u32 WIMPORT_WRITE16 = 4;
static constexpr u32 WIMPORT_WRITE32 = 5;

// Scratch locals reserved by the per-block layout (mirror gekko_emit.h
// LOCAL_TMP_A/B locked indices).
static constexpr u32 LOCAL_TMP_EA  = 0;
static constexpr u32 LOCAL_TMP_VAL = 1;
// [perf] Scratch i32 for a scalar-FP store's converted single-precision bits.
// It must NOT be LOCAL_TMP_VAL: emit_fastmem_guard tees the region selector
// into LOCAL_TMP_VAL and emit_bswap_i32 uses it too, so a value parked there
// before the guard is destroyed. Aliases the psq-scratch slot (98) — free for
// scalar stfs/stfsx (psq_st never co-emits with a scalar FP store in one op).
static constexpr u32 LOCAL_TMP_FPVAL = 98;

// ---------------------------------------------------------------------------
// EA computation
// ---------------------------------------------------------------------------
static void emit_ea_d_form(WasmModuleBuilder& wb, RegCache& rc, u32 ra, u32 simm,
                           EaCache* cache = nullptr) {
    // [PM55 EA-CSE] Reuse LOCAL_TMP_EA when the immediately-preceding D-form
    // memory op computed the identical (ra, simm) and the base was not
    // written since (the dispatch loop clears cache->valid on any regsOut
    // hit; any intervening mem op overwrites this record). Emits nothing.
    if (cache && cache->valid && cache->ra == (s32)ra && cache->simm == (s32)simm)
        return;
    if (ra == 0) {
        wb.op_i32_const((s32)simm);
    } else {
        auto rc_a = rc.Bind(ra, RCMode::Read);
        wb.op_local_get(rc_a.local_idx());
        wb.op_i32_const((s32)simm);
        wb.op_i32_add();
    }
    wb.op_local_set(LOCAL_TMP_EA);
    if (cache) { cache->ra = (s32)ra; cache->simm = (s32)simm; cache->valid = true; }
}

static void emit_ea_x_form(WasmModuleBuilder& wb, RegCache& rc, u32 ra, u32 rb) {
    auto rc_b = rc.Bind(rb, RCMode::Read);
    if (ra == 0) {
        wb.op_local_get(rc_b.local_idx());
    } else {
        auto rc_a = rc.Bind(ra, RCMode::Read);
        wb.op_local_get(rc_a.local_idx());
        wb.op_local_get(rc_b.local_idx());
        wb.op_i32_add();
    }
    wb.op_local_set(LOCAL_TMP_EA);
}

// [PM55 DSI-guard-dead 2026-08-04] emit_no_dsi_guard DELETED — it was provably
// dead in the shipping MMU-off config (Dolphin GenerateDSIException early-
// returns without setting EXCEPTION_DSI when !IsMMUMode(); the stateless fast-
// router never consults the MMU), so no load/store fault ever set the bit it
// masked. All 4 call sites now commit unconditionally. Native-exact DSI is the
// deferred Stage B (slow-arm self-exit + a matching host raise). See
// wf_711c363b for the oracle verification.

// ---------------------------------------------------------------------------
// emit_fastmem_guard — push i32 (1 = fastmem hit, 0 = miss) onto stack.
//
// `access_bytes` is the size of the upcoming load/store (1/2/4) so the
// bound check accounts for accesses that straddle the MEM1 tail. Without
// this, a 4-byte access at EA = ram_size - 1 passes the guard but reads
// bytes through ram_size + 2 → wasm linear-memory OOB trap when the host
// heap hasn't grown past mem1_base + ram_size + (width-1). Pass-6 audit
// 2026-06-06 (workflow a8a87199a5f5ac928): root cause of the OOB trap
// observed shortly after `Audio DMA configured` — a JIT block hit the
// MEM1 tail during the audio ISR's context save path with width>1.
// ---------------------------------------------------------------------------
static void emit_fastmem_guard(WasmModuleBuilder& wb, LoadStoreParams params,
                               u32 access_bytes) {
    // Degenerate MEM1 window (ram_size smaller than the access width — e.g.
    // an unconfigured mem1 in a test harness): the `ram_size -
    // (access_bytes - 1)` bound below wraps unsigned and ADMITS every
    // address into the fast path, whose host address (EA & mask) + base
    // then aliases low linear memory (observed as address-zero heap
    // corruption in test_gekko_next). Emit constant-false so the select
    // always takes the trampoline — matches legacy build_block's behavior
    // when mem1 is unconfigured. Compile-time constant; zero cost on a
    // real config.
    if (params.ram_size < access_bytes) {
        wb.op_i32_const(0);
        return;
    }
#ifndef BEM_FASTMEM_REGION_FIX
#define BEM_FASTMEM_REGION_FIX 1
#endif
#if BEM_FASTMEM_REGION_FIX
    // FASTMEM REGION CLASSIFIER (fix 2026-06-21): the old `(EA & 0x1F000000)==0`
    // test only admitted the first 16 MB, so guest addresses above 0x80FFFFFF —
    // INCLUDING the PSO stack at 0x817xxxxx (top of 24 MB MEM1) — were wrongly
    // rejected to the ppc_read/write import slow path on every spill. Admit
    // exactly the three RAM mirrors {phys 0x00, cached 0x80, uncached 0xC0} via
    // (EA & 0xFE000000), which groups 0x80/0x81 (and 0xC0/0xC1) to one selector;
    // 0xCC* MMIO masks to 0xCC000000, matches none, and correctly stays on the
    // import (no aliasing). The bound check below still confines to ram_size.
    // [fastmem-classify-1op 2026-07-14] The 3-mirror admit {0x00,0x80,0xC0}
    // (mask 0xFE000000 + eqz + two eq-compares OR'd, ~13 ops) is EQUIVALENT, for
    // every address a GameCube title actually issues, to the single test
    // (EA & 0x3E000000) == 0:
    //   0x00/0x01 phys, 0x80/0x81 cached, 0xC0/0xC1 uncached -> &0x3E000000 == 0 (admit)
    //   0xCC MMIO (->0x0C), 0xC8 EFB (->0x08), 0xE0 locked-cache (->0x20) -> !=0 (reject->import)
    // The only EAs this admits that the 3-compare rejected are 0x40/0x41 and the
    // physical mirror above 24MB — regions no GC game accesses; and the
    // (EA & mem1_mask) in emit_fastmem_store confines any admitted EA to the 32MB
    // window regardless, so there is no new aliasing for real addresses. Cuts ~9
    // wasm ops off EVERY load/store — the per-op fastmem gap vs the oracle JIT the
    // header (line ~175) flags. Validated by boot byte-identity + render probe
    // (region classify is NOT conformance-covered).
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)0x3E000000u);
    wb.op_i32_and();
    wb.op_i32_eqz();
#else
    // (EA & 0x1F000000) == 0  — legacy guard (16 MB only; rejects 0x817xxxxx).
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const(0x1F000000);
    wb.op_i32_and();
    wb.op_i32_eqz();
#endif
    // [fastmem-narrow 2026-07-13 oracle-match] Bounds check ELIDED when mem1_mask == ram_size-1
    // (ALWAYS true for a real config: Memmap.cpp m_ram_size = NextPowerOf2(real) = 32MB,
    // m_ram_mask = ram_size-1 = 0x01FFFFFF). Then (EA & mask) is unconditionally in [0, ram_size),
    // so base+(EA&mask) is always inside the 32MB allocation — the region classify above already
    // rejected MMIO (the only aliasing risk). The lone exception is a multi-byte access straddling
    // the very TOP of the 32MB mirror (0x81FFFFFD+, padding no game touches; the wasm engine still
    // bounds-checks the whole linear memory, and Dolphin's fastmem does no per-access bound
    // either). This removes ~6 ops from EVERY memory access — the biggest per-op gap vs the oracle
    // JIT (Dolphin fastmem = raw access + SIGSEGV backpatch, zero guard). Kept for odd configs.
    if (params.mem1_mask != params.ram_size - 1u) {
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_i32_const((s32)params.mem1_mask);
        wb.op_i32_and();
        wb.op_i32_const((s32)(params.ram_size - (access_bytes - 1)));
        wb.op_i32_lt_u();
        wb.op_i32_and();
    }
}

static u32 load_width_bytes(LoadWidth w) {
    switch (w) {
    case LoadWidth::U8:  return 1;
    case LoadWidth::U16: return 2;
    case LoadWidth::S16: return 2;
    case LoadWidth::U32: return 4;
    }
    return 4;
}

static u32 store_width_bytes(StoreWidth w) {
    switch (w) {
    case StoreWidth::U8:  return 1;
    case StoreWidth::U16: return 2;
    case StoreWidth::U32: return 4;
    }
    return 4;
}

// ---------------------------------------------------------------------------
// Byte-swap helpers — PowerPC is big-endian; WASM linear memory is
// little-endian. After every fastmem load we byte-swap; before every
// fastmem store we byte-swap.
// ---------------------------------------------------------------------------
// [2026-08-12 cycle-ledger strip instrument] true = emit NO byte-swap (value passes
// through unswapped — WRONG results, measurement-ONLY). Sizes the bswap emit cost as a
// cycle delta via test_gekko_next's cycle_ledger. Result 2026-08-12: bswap kernel
// 42.6->40.6 ns/iter = FLAT (V8 folds the rotr/and) — bswap is NOT a convertible tax.
// Keep default false (gated instrument).
static constexpr bool BEM_STRIP_BSWAP = false;
static void emit_bswap_i32(WasmModuleBuilder& wb) {
    if (BEM_STRIP_BSWAP) return;   // value already on the stack; leave it unswapped
    // [bswap-rotate 2026-07-14] bswap32(x) = (rotr(x,8) & 0xFF00FF00) | (rotl(x,8) & 0x00FF00FF).
    // 11 ops vs the prior 18-op two-stage shl/shr/or form — fires on EVERY 32-bit fastmem
    // load and store, so a load+store pair drops ~36->22 emitted ops. Verified bit-exact
    // (0/500000 mismatches vs true bswap; workflow wf_d90f8071 adversarial verify): e.g.
    // x=0x11223344 -> rotr8=0x44112233 &0xFF00FF00=0x44002200 ; rotl8=0x22334411 &0x00FF00FF=
    // 0x00330011 ; OR=0x44332211. Pure ALU equivalence; conformance-covered (test_diff_next).
    wb.op_local_tee(LOCAL_TMP_VAL);
    wb.op_i32_const(8);
    wb.op_i32_rotr();
    wb.op_i32_const((s32)0xFF00FF00u);
    wb.op_i32_and();
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(8);
    wb.op_i32_rotl();
    wb.op_i32_const(0x00FF00FF);
    wb.op_i32_and();
    wb.op_i32_or();
}

static void emit_bswap_i16(WasmModuleBuilder& wb) {
    if (BEM_STRIP_BSWAP) return;
    wb.op_local_tee(LOCAL_TMP_VAL);
    wb.op_i32_const(8);
    wb.op_i32_shl();
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(8);
    wb.op_i32_shr_u();
    wb.op_i32_const(0xFF);
    wb.op_i32_and();
    wb.op_i32_or();
    wb.op_i32_const(0xFFFF);
    wb.op_i32_and();
}

static u32 read_import_for_width(LoadWidth w) {
    switch (w) {
    case LoadWidth::U8:  return WIMPORT_READ8;
    case LoadWidth::U16: return WIMPORT_READ16;
    case LoadWidth::S16: return WIMPORT_READ16;
    case LoadWidth::U32: return WIMPORT_READ32;
    }
    return WIMPORT_READ32;
}

static u32 write_import_for_width(StoreWidth w) {
    switch (w) {
    case StoreWidth::U8:  return WIMPORT_WRITE8;
    case StoreWidth::U16: return WIMPORT_WRITE16;
    case StoreWidth::U32: return WIMPORT_WRITE32;
    }
    return WIMPORT_WRITE32;
}

// ---------------------------------------------------------------------------
// Fast-path load: leaves loaded+swapped value on the stack.
// ---------------------------------------------------------------------------
static void emit_fastmem_load_value(WasmModuleBuilder& wb,
                                    LoadStoreParams params, LoadWidth width) {
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)params.mem1_mask);
    wb.op_i32_and();
    wb.op_i32_const((s32)params.mem1_base);
    wb.op_i32_add();
    switch (width) {
    case LoadWidth::U8:
        wb.op_i32_load8_u(0);
        break;
    case LoadWidth::U16:
        wb.op_i32_load16_u(0);
        emit_bswap_i16(wb);
        break;
    case LoadWidth::S16:
        wb.op_i32_load16_u(0);
        emit_bswap_i16(wb);
        // sign-extend 16-bit → 32
        wb.op_i32_const(16);
        wb.op_i32_shl();
        wb.op_i32_const(16);
        wb.op_i32_shr_s();
        break;
    case LoadWidth::U32:
        wb.op_i32_load(0);
        emit_bswap_i32(wb);
        break;
    }
}

// [lc-window PM23] Push 1 iff EA is inside the locked-L1 region
// [0xE0000000, 0xE0040000) — mirrors MMU.cpp's accept exactly.
static void emit_lc_region_test(WasmModuleBuilder& wb) {
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)0xFFFC0000u);
    wb.op_i32_and();
    wb.op_i32_const((s32)0xE0000000u);
    wb.op_i32_eq();
}

// [lc-window PM23] Push the locked-L1 host address for EA.
static void emit_lc_addr(WasmModuleBuilder& wb, LoadStoreParams params) {
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const(0x3FFFF);
    wb.op_i32_and();
    wb.op_i32_const((s32)params.lc_base);
    wb.op_i32_add();
}

// Slow-path load. Leaves value (with sign-extension if LoadWidth::S16) on
// the stack. [lc-window PM23] When lc_base is configured, locked-L1 EAs are
// served by a raw in-wasm load (guest-BE backing, same convention as RAM —
// MMU.cpp memcpy+bswap parity) instead of the cross-instance import; the
// region test only ever executes on the ALREADY-SLOW arm, so RAM fast hits
// pay nothing. Result carried through LOCAL_TMP_VAL (bswap scratch is
// sequential-safe; callers that keep a live value there must re-load after).
static void emit_slowmem_load_value(WasmModuleBuilder& wb,
                                    LoadStoreParams params, LoadWidth width) {
    if (params.lc_base) {
        emit_lc_region_test(wb);
        wb.op_if(BLOCK_TYPE_VOID);
            emit_lc_addr(wb, params);
            switch (width) {
            case LoadWidth::U8:
                wb.op_i32_load8_u(0);
                break;
            case LoadWidth::U16:
                wb.op_i32_load16_u(0);
                emit_bswap_i16(wb);
                break;
            case LoadWidth::S16:
                wb.op_i32_load16_u(0);
                emit_bswap_i16(wb);
                wb.op_i32_const(16);
                wb.op_i32_shl();
                wb.op_i32_const(16);
                wb.op_i32_shr_s();
                break;
            case LoadWidth::U32:
                wb.op_i32_load(0);
                emit_bswap_i32(wb);
                break;
            }
            wb.op_local_set(LOCAL_TMP_VAL);
        wb.op_else();
            wb.op_local_get(LOCAL_TMP_EA);
            wb.op_call(read_import_for_width(width));
            if (width == LoadWidth::S16) {
                wb.op_i32_const(16);
                wb.op_i32_shl();
                wb.op_i32_const(16);
                wb.op_i32_shr_s();
            }
            wb.op_local_set(LOCAL_TMP_VAL);
        wb.op_end();
        wb.op_local_get(LOCAL_TMP_VAL);
        return;
    }
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_call(read_import_for_width(width));
    if (width == LoadWidth::S16) {
        wb.op_i32_const(16);
        wb.op_i32_shl();
        wb.op_i32_const(16);
        wb.op_i32_shr_s();
    }
}

// Fast-path store: pops nothing additional; uses src_local as the value
// source. Stack-neutral.
static void emit_fastmem_store(WasmModuleBuilder& wb, LoadStoreParams params,
                               StoreWidth width, u32 src_local) {
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)params.mem1_mask);
    wb.op_i32_and();
    wb.op_i32_const((s32)params.mem1_base);
    wb.op_i32_add();
    wb.op_local_get(src_local);
    switch (width) {
    case StoreWidth::U8:
        wb.op_i32_store8(0);
        break;
    case StoreWidth::U16:
        emit_bswap_i16(wb);
        wb.op_i32_store16(0);
        break;
    case StoreWidth::U32:
        emit_bswap_i32(wb);
        wb.op_i32_store(0);
        break;
    }
}

// ---------------------------------------------------------------------------
// [gp-inwasm 2026-08-28] Write-gather-pipe (WPAR) in-wasm arm — the same shape
// as the [lc-window PM23] arm above, applied to the OTHER fixed, well-known
// guest range that leaves the JIT's wasm instance on every access.
//
// WHAT IT REPLACES, EXACTLY. The bridge's dolphin_write32 (dolphin-bridge/
// dolphin_jit_wimports.cpp:263-275) already short-circuits a WPAR store before
// the MMU:
//     void dolphin_write32(uint32_t addr, uint32_t val) {
//         gp_dirty_check(addr);
//         if ((addr & 0x0FFFFFFFu) == 0x0C008000u) {
//             Core::System::GetInstance().GetGPFifo().Write32(val);
//             return;
//         }
//         ...
//     }
// so the host side of a gather write is exactly: g_bem_gp_dirty = 1;
// GPFifo::Write32(val) = redirect-check -> FastWrite32 -> CheckGatherPipe.
// FastWrite32 (Core/HW/GPFifo.cpp:295-301) is `swap32(v); memcpy(ppc_state
// .gather_pipe_ptr, &v, 4); gather_pipe_ptr += 4;` — byte-for-byte the store
// this emitter already emits for fastmem RAM. CheckGatherPipe (GPFifo.cpp:179)
// is `if (gather_pipe_ptr - gather_pipe_base_ptr >= 32) { UpdateGatherPipe();
// CompileExceptionCheck(FIFOWrite); }`. We reproduce all of it in wasm except
// UpdateGatherPipe itself, which stays a host call through WIMPORT_GATHER_DRAIN
// (dolphin_gather_drain -> GPFifo::UpdateGatherPipe + clear g_bem_gp_dirty).
//
// ORDERING — [xf-word-loss FIX PM37] IS NOT AFFECTED. That pairing is between
// UpdateGatherPipe's `memcpy -> atomic_thread_fence(release) -> accounting`
// (GPFifo.cpp:150-163) and the decoder's acquire load of CPReadWriteDistance
// (VideoCommon/Fifo.cpp:399). BOTH halves stay exactly where they are: the
// bytes this arm writes go into the CPU-private 512-byte staging buffer
// m_gather_pipe, which no other thread ever reads (GPFifo.cpp:150 is the only
// reader, on this thread). Nothing publishes a +32 credit except
// UpdateGatherPipe, and it is still reached only through the host import — a
// wasm `call` to an import that the engine may not reorder guest stores across.
// So a consumer can still never observe the credit before the bytes.
//
// DRAIN CADENCE IS UNCHANGED. Today every WPAR store crosses and its
// CheckGatherPipe drains at each 32-byte boundary. This arm drains at the
// same boundary, from the same instruction position, so the FIFO burst
// sequence is identical — only 7 of every 8 module crossings disappear. The
// existing deferred drains (block epilogue ppc_emit.cpp:1670-1685, fused-loop
// back-edge jit_branch.cpp:476-487, coalesced taken exit jit_branch.cpp:82-88)
// are all gated on g_bem_gp_dirty, which this arm sets, so the sub-32-byte
// residual is still flushed on every exit exactly as before.
//
// TAKEOVER SAFETY. GPFifo::Write32 first calls gpfifo_redirect_excursion_to_ring
// (GPFifo.cpp:214-235), which diverts the word into the ppc-worker's ordered
// ring when cpu_owner (SAB 0x026A0000) == 1 && !g_in_drain. That path must not
// be bypassed, so the arm's predicate carries a runtime `cpu_owner == 0` term
// and falls back to the import whenever the worker owns the CPU. (In the
// shipping config cpu_owner stays 0 — gamecube.html:2274-2277 returns before
// the takeover store — but the guard makes the arm correct either way.)
// The other early-out in that function, g_gp_discard, is only ever assigned 0:
// GPFifo.cpp:23 initialises it to 0, dolphin_gp_seal/unseal are retired inert
// stubs (dolphin_jit_wimports.cpp:283-291), and EmscriptenWorker.cpp:734-749
// only clears and restores it. It cannot be 1 while a JIT block runs.
//
// NOT REPRODUCED: JitInterface::CompileExceptionCheck(FIFOWrite). It records
// ppc_state.pc in Jit64's js.fifoWriteAddresses and invalidates the INHERITED
// JitBaseBlockCache — which JitWasm.cpp:461-464 documents as not knowing about
// m_wasm_cache — so it steers no codegen of ours. It measured 1.695% of this
// worker's working time in /tmp/worker_4.cpuprofile.
//
// GATED on params.lc_base (the established "real dolphin build / big SAB
// present" gate, jit_load_store.cpp:38): with lc_base == 0 — the standalone
// test links and any offline emit without a live ctx — ppc_state.gather_pipe_ptr
// is not a valid linear-memory pointer, so the arm must stay unemitted and the
// import path must remain byte-identical. Flip BEM_GP_INWASM_ARM to false for a
// clean A/B against the all-import baseline.
// ---------------------------------------------------------------------------
static constexpr bool BEM_GP_INWASM_ARM = true;

// SAB dual-core ownership cell (0 = dolphin EmuThread owns the guest CPU,
// 1 = ppc-worker takeover). Same literal the bridge reads at
// dolphin_jit_wimports.cpp:112 and GPFifo.cpp:217.
static constexpr u32 GP_CPU_OWNER_CELL = 0x026A0000u;
// The bridge's own WPAR predicate (dolphin_jit_wimports.cpp:269 and the
// gp_dirty_check at :91). Matches phys 0x0C008000 and its 0x8C/0xCC BAT
// mirrors — the only forms a GameCube title issues.
static constexpr u32 GP_EA_MASK  = 0x0FFFFFFFu;
static constexpr u32 GP_EA_MATCH = 0x0C008000u;
// GPFifo::GATHER_PIPE_SIZE (Core/HW/GPFifo.h:21).
static constexpr u32 GP_PIPE_SIZE = 32u;
// PowerPCState offsets. PowerPC.h:123-133 lays out pc(4) npc(4)
// stored_stack_pointer(4) gather_pipe_ptr(4) gather_pipe_base_ptr(4) gpr[32],
// and ppc_offsets.h pins GPR_BASE at 0x014 — which forces these two.
static constexpr u32 PPCSTATE_GATHER_PIPE_PTR      = 0x00Cu;
static constexpr u32 PPCSTATE_GATHER_PIPE_BASE_PTR = 0x010u;
// ppc_gather_drain — block-module import idx 12 (hle_prologue.h:30-34); the
// same import jit_branch.cpp calls from its exit drains.
static constexpr u32 WIMPORT_GATHER_DRAIN = 12;

// &g_bem_gp_dirty as an emitted const — sentinel + reloc record under the
// offline AOT builder, plain const otherwise. Mirrors jit_branch.cpp's
// emit_gp_dirty_addr (jit_branch.cpp:56-64).
static inline void emit_gp_dirty_addr_ls(WasmModuleBuilder& wb) {
    if (g_bem_aot_reloc_mode)
        wb.op_i32_const_reloc((u16)BEM_RSYM_GP_DIRTY, 0u,
                              bem_reloc_sentinel((u16)BEM_RSYM_GP_DIRTY, 0u));
    else
        wb.op_i32_const((s32)(uintptr_t)&g_bem_gp_dirty);
}

// Push 1 iff this EA is a write-gather-pipe store AND dolphin's own CPU thread
// still owns the guest (so the excursion-to-ring redirect is not in play).
static void emit_gp_region_test(WasmModuleBuilder& wb) {
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)GP_EA_MASK);
    wb.op_i32_and();
    wb.op_i32_const((s32)GP_EA_MATCH);
    wb.op_i32_eq();
    wb.op_i32_const((s32)GP_CPU_OWNER_CELL);
    wb.op_i32_load(0);
    wb.op_i32_eqz();
    wb.op_i32_and();
}

// GPFifo::FastWrite{8,16,32} + CheckGatherPipe, emitted inline. Stack-neutral.
//
// LOCAL FOOTPRINT — deliberately IDENTICAL to the LC arm directly below it: it
// reads LOCAL_TMP_EA (through the caller's region test) and clobbers only
// LOCAL_TMP_VAL, and only via emit_bswap_i{16,32}, which the LC arm already
// calls on the same values. The pipe cursor is re-loaded from PowerPCState for
// the boundary test rather than parked in a local, so this arm introduces NO
// new liveness constraint on any caller (psq_st in particular keeps its GQR in
// LOCAL_TMP_VAL, and its existing contract — see emit_slowmem_load_value's
// header — already treats that slot as dead across a slow store).
static void emit_gp_append(WasmModuleBuilder& wb, LoadStoreParams params,
                           StoreWidth width, u32 src_local) {
    const u32 ctx   = params.ctx_ptr;
    const u32 bytes = store_width_bytes(width);

    // *gather_pipe_ptr = swap(value)   [FastWrite32: swap32 then 4-byte memcpy —
    // hence align 0 on the u32 store; the pipe pointer can be byte-advanced by a
    // preceding stb, exactly as FastWrite8 leaves it.]
    wb.op_i32_const((s32)ctx);
    wb.op_i32_load(PPCSTATE_GATHER_PIPE_PTR);
    wb.op_local_get(src_local);
    switch (width) {
    case StoreWidth::U8:
        wb.op_i32_store8(0);
        break;
    case StoreWidth::U16:
        emit_bswap_i16(wb);
        wb.op_i32_store16(0);
        break;
    case StoreWidth::U32:
        emit_bswap_i32(wb);
        wb.op_i32_store(0, 0);
        break;
    }

    // gather_pipe_ptr += width
    wb.op_i32_const((s32)ctx);
    wb.op_i32_const((s32)ctx);
    wb.op_i32_load(PPCSTATE_GATHER_PIPE_PTR);
    wb.op_i32_const((s32)bytes);
    wb.op_i32_add();
    wb.op_i32_store(PPCSTATE_GATHER_PIPE_PTR);

    // g_bem_gp_dirty = 1 — the host used to set this in gp_dirty_check; every
    // deferred exit drain is gated on it, so the arm must keep setting it or a
    // sub-32-byte residual would sit in the pipe past block exit.
    emit_gp_dirty_addr_ls(wb);
    wb.op_i32_const(1);
    wb.op_i32_store(0);

    // CheckGatherPipe: if (ptr - base) >= 32 -> host UpdateGatherPipe. This is
    // also what bounds m_gather_pipe (512 bytes, GPFifo.h:22): without it a
    // long straight-line or in-wasm-looping run of WPAR stores would overrun
    // the staging buffer, since this emitter's back-edges do not always reach
    // the block epilogue.
    wb.op_i32_const((s32)ctx);
    wb.op_i32_load(PPCSTATE_GATHER_PIPE_PTR);
    wb.op_i32_const((s32)ctx);
    wb.op_i32_load(PPCSTATE_GATHER_PIPE_BASE_PTR);
    wb.op_i32_sub();
    wb.op_i32_const((s32)GP_PIPE_SIZE);
    wb.op_i32_ge_u();
    wb.op_if(BLOCK_TYPE_VOID);
        wb.op_i32_const(0);
        wb.op_i32_const(0);
        wb.op_call(WIMPORT_GATHER_DRAIN);
    wb.op_end();
}

// The non-LC tail of the slow store arm: WPAR in-wasm append, else the import.
static void emit_gp_or_import_store(WasmModuleBuilder& wb, LoadStoreParams params,
                                    StoreWidth width, u32 src_local) {
    if (BEM_GP_INWASM_ARM && params.lc_base) {
        emit_gp_region_test(wb);
        wb.op_if(BLOCK_TYPE_VOID);
            emit_gp_append(wb, params, width, src_local);
        wb.op_else();
            wb.op_local_get(LOCAL_TMP_EA);
            wb.op_local_get(src_local);
            wb.op_call(write_import_for_width(width));
        wb.op_end();
        return;
    }
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_local_get(src_local);
    wb.op_call(write_import_for_width(width));
}

// ---------------------------------------------------------------------------
// [gp-inwasm FP-words 2026-08-29] The same WPAR arm for an FP store that writes
// ONE or TWO consecutive 32-bit words starting at LOCAL_TMP_EA. psq_st's FLOAT
// (GQR type 0) branch hand-rolls its own WIMPORT_WRITE32 pair instead of going
// through emit_slowmem_store, so it was the one store class the [gp-inwasm] arm
// never covered — measured live at psqFloatWPAR=32965 events on the PSO census
// run (/tmp/gp-C1.log:21).
//
// WHY ONE REGION TEST COVERS BOTH LANES. The predicate here is the bridge's own
// exact match on LANE 0's EA (dolphin_jit_wimports.cpp:269). Lane 1 lands at
// EA+4, which that exact match REJECTS — the host then falls through
// stateless_write_w (dolphin_jit_wimports.cpp:166-171, `if (!worker_owns_cpu())
// return false` — so it declines while dolphin owns the CPU, which is exactly
// the state this arm's cpu_owner==0 term requires) into MMU::Write<u32>, whose
// gather-pipe check is a 4KB PAGE match (MMU.cpp:362,
// `(em_address & 0xFFFFF000) == GPFifo::GATHER_PIPE_PHYSICAL_ADDRESS`) and
// therefore routes lane 1 to GPFifo::Write32 after all. So the host's net effect
// for a WPAR-based pair is Write32(lane0) then Write32(lane1) — which is what
// this arm emits, minus the full MMU translate on lane 1. Testing lane 0 only is
// not an approximation: it is the host's own decision point, and the page match
// makes EA+4 unconditionally follow lane 0 into the pipe.
//
// The arm is therefore NEVER more permissive than the host: it appends only when
// lane 0 exactly matches WPAR (the case where the host provably routes BOTH lanes
// to the pipe), and any other EA — including a pair that starts mid-page at
// EA=...C008004 — falls to the untouched import pair, which reaches the pipe via
// the same page match it always did.
//
// LOCALS. emit_gp_append reads `ctx` + `src_local` and clobbers only
// LOCAL_TMP_VAL (via emit_bswap_i32:232, an op_local_tee). It never writes
// LOCAL_TMP_EA — only emit_gp_region_test READS it — so the caller's EA survives
// for psq_stu/stfdu's RA writeback. `scratch_local` is caller-chosen for the same
// reason: psq_st's FLOAT arm passes LOCAL_PSQ_T1 (99), which is the host-base
// scratch of the co-located FASTMEM arm (jit_load_store.cpp:2067) and hence dead
// on this mutually-exclusive slow arm, and which none of emit_store_bits /
// emit_ftz_f32_bits / emit_convert_to_single_ftz touches.
//
// LOCAL_TMP_VAL is dead here: emit_fastmem_guard (called immediately before this
// arm's enclosing if/else) already tees its region selector into it — the reason
// LOCAL_TMP_FPVAL exists at all (see the note at :61-66).
//
// ORDERING. Each word is appended and then boundary-checked at the SAME
// instruction position GPFifo::Write32 checks (FastWrite32 -> CheckGatherPipe,
// GPFifo.cpp:251-258), so the 32-byte burst sequence is unchanged. The bytes go
// into m_gather_pipe, the CPU-private staging buffer whose only reader is the
// same-thread memcpy at GPFifo.cpp:150; the release fence at :154 and the
// decoder's acquire load (VideoCommon/Fifo.cpp:387-396) are both untouched, so a
// +32 credit still cannot be observed before the bytes land.
// ---------------------------------------------------------------------------
template <typename EmitWord>
static void emit_fp_words_gp_or_import(WasmModuleBuilder& wb, LoadStoreParams params,
                                       u32 nwords, u32 scratch_local,
                                       EmitWord emit_word) {
    // The byte-identical pre-existing behaviour: write32(EA + 4i, word_i).
    auto emit_imports = [&]() {
        for (u32 i = 0; i < nwords; ++i) {
            wb.op_local_get(LOCAL_TMP_EA);
            if (i != 0) {
                wb.op_i32_const((s32)(i * 4u));
                wb.op_i32_add();
            }
            emit_word(i);
            wb.op_call(WIMPORT_WRITE32);
        }
    };
    if (BEM_GP_INWASM_ARM && params.lc_base) {
        emit_gp_region_test(wb);
        wb.op_if(BLOCK_TYPE_VOID);
            for (u32 i = 0; i < nwords; ++i) {
                emit_word(i);
                wb.op_local_set(scratch_local);
                emit_gp_append(wb, params, StoreWidth::U32, scratch_local);
            }
        wb.op_else();
            emit_imports();
        wb.op_end();
        return;
    }
    emit_imports();
}

// Slow-path store. Stack-neutral. [lc-window PM23] locked-L1 EAs get a raw
// in-wasm store (bswap + store, matching MMU.cpp's swapped memcpy) when
// lc_base is configured — see emit_slowmem_load_value. [gp-inwasm] everything
// else first tries the write-gather-pipe arm above before the import.
static void emit_slowmem_store(WasmModuleBuilder& wb, LoadStoreParams params,
                               StoreWidth width, u32 src_local) {
    if (params.lc_base) {
        emit_lc_region_test(wb);
        wb.op_if(BLOCK_TYPE_VOID);
            emit_lc_addr(wb, params);
            wb.op_local_get(src_local);
            switch (width) {
            case StoreWidth::U8:
                wb.op_i32_store8(0);
                break;
            case StoreWidth::U16:
                emit_bswap_i16(wb);
                wb.op_i32_store16(0);
                break;
            case StoreWidth::U32:
                emit_bswap_i32(wb);
                wb.op_i32_store(0);
                break;
            }
        wb.op_else();
            emit_gp_or_import_store(wb, params, width, src_local);
        wb.op_end();
        return;
    }
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_local_get(src_local);
    wb.op_call(write_import_for_width(width));
}

// ---------------------------------------------------------------------------
// emit_load — shared D-form / X-form load implementation. Caller has
// already emitted EA into LOCAL_TMP_EA.
// ---------------------------------------------------------------------------
static void emit_load_common(WasmModuleBuilder& wb, RegCache& rc,
                             FPRRegCache& frc,
                             LoadStoreParams params, u32 rt, u32 ra,
                             LoadWidth width, bool update) {
    // Push fastmem-guard onto stack, then flush dirty bindings, THEN bind
    // rt for Write. Binding rt before the flush was a memory-corruption
    // bug — Bind(Write) marks rt dirty, and the subsequent Flush then
    // writes rt's stale wasm-local-default (0) to memory[gpr(rt)] before
    // the load result is produced. The block's end-of-flow flush only
    // covers locals that were re-marked dirty AFTER the load, so the
    // zero-write was the final memory state. 2026-05-31 SAB boot:
    // L2GlobalInvalidate's epilogue `lwz r31, 12(r1)` zeroed memory's
    // gpr(31) slot mid-load, surfacing as __init_hardware's mtlr r31; blr
    // returning to PC=0 (caller-saved r31 = 0 after function return).
    emit_fastmem_guard(wb, params, load_width_bytes(width));
    rc.Flush(params.ctx_ptr);  // stack-neutral — guard stays on top
    // [flush-narrow 2026-07-13] NO frc.Flush here. This is the INTEGER load path
    // (rt is a GPR); the slow arm's host handler (MMU/MMIO — dolphin_read*) reads
    // guest gpr[] (e.g. ExpansionInterface gpr[3..5]) but NEVER ps[]/FPRs, and
    // every exception-delivery / HLE / block-exit point re-flushes FPRs itself
    // (emit_fallback ppc_emit.cpp:215-216, FP-unavail :800-801, epilogue). The old
    // unconditional frc.Flush ran EmitPromoteToDouble on every live Single FPR
    // before every integer load — promote/demote thrash in FP-interleaved loops
    // (PSMTXROMultVecArray, THP). Removing it is coherence-neutral for the integer
    // path. (rc.Flush for GPRs STAYS — host handlers do read gpr, and the
    // flush-before-Bind(rt,Write) ordering below still requires it.)

    // Bind RT now (post-flush). Marks rt dirty so its end-of-block flush
    // writes the loaded value back to memory.
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    const u32 rt_local = rc_rt.local_idx();

    wb.op_if(BLOCK_TYPE_VOID);

    // ---- fast path ----
    // [C6 2026-07-12 oracle-audit] Park the loaded value in LOCAL_TMP_FPVAL
    // (free for integer loads — only psq/scalar-FP use slot 98) instead of
    // committing to rt_local here; the RT commit is gated on !DSI below to
    // match Interpreter_LoadStore.cpp lbz:46 / lbzu:56-60.
    emit_fastmem_load_value(wb, params, width);
    wb.op_local_set(LOCAL_TMP_FPVAL);

    wb.op_else();

    // ---- slow path ----
    emit_slowmem_load_value(wb, params, width);
    wb.op_local_set(LOCAL_TMP_FPVAL);

    wb.op_end();

    // RegCache invalidates immediate-tracking on merge — emitter doesn't
    // need to do it manually since we marked rt dirty via Bind(Write) and
    // both arms wrote through to the same local.

    // [PM55 DSI-guard-dead 2026-08-04] Commit RT (and update-form RA)
    // UNCONDITIONALLY. The old !(Exceptions & EXCEPTION_DSI) guard was
    // provably dead in the shipping MMU-off config: verified against the
    // oracle (wf_711c363b) — Dolphin's GenerateDSIException early-returns
    // WITHOUT setting EXCEPTION_DSI when !IsMMUMode() (MAIN_MMU defaults
    // false), and the stateless fast-router never consults the MMU, so no
    // load/store fault ever sets the bit the guard masked. eqz was always 1,
    // the commit if always taken — ~9 dead ops per load. Deleting it is
    // behaviorally identical (nothing was ever suppressed). Native-exact
    // DSI (slow-arm self-exit + a host raise) is the deferred Stage B pair.
    wb.op_local_get(LOCAL_TMP_FPVAL);
    wb.op_local_set(rt_local);
    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

static void emit_store_common(WasmModuleBuilder& wb, RegCache& rc,
                              FPRRegCache& frc,
                              LoadStoreParams params, u32 rs, u32 ra,
                              StoreWidth width, bool update) {
    // Read RS — bind for the value-to-be-stored.
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    const u32 rs_local = rc_rs.local_idx();

    emit_fastmem_guard(wb, params, store_width_bytes(width));
    rc.Flush(params.ctx_ptr);
    // [flush-narrow 2026-07-13] NO frc.Flush — INTEGER store path (rs is a GPR).
    // The slow arm's host WRITE handler (dolphin_write*: MMU / GPFifo / DSP mailbox
    // / EXI) reads the value from gpr and inspects gpr[], never ps[]/FPRs; FPRs are
    // re-flushed at every exception/HLE/exit point. Removes per-store Single-FPR
    // promote thrash in FP-interleaved code. rc.Flush (GPRs) stays. See emit_load_common.
    wb.op_if(BLOCK_TYPE_VOID);

    emit_fastmem_store(wb, params, width, rs_local);

    wb.op_else();

    emit_slowmem_store(wb, params, width, rs_local);

    wb.op_end();

    // [C6 2026-07-12 oracle-audit] Update-form stores (stbu/sthu/stwu, opcd
    // 39/45/37) commit RA <- EA only when the store did not raise DSI. Oracle:
    // Interpreter_LoadStore.cpp stbu:457-460 (`if (!(Exceptions & EXCEPTION_DSI))
    // gpr[RA] = address`). Previously unconditional (TODO 2026-06-01) — now the
    // ppc_off::EXCEPTION_DSI constant exists so the guard is emitted. The fast
    // arm cannot fault, so this is a no-op there; on a faulting slow arm it
    // suppresses the RA desync.
    if (update && ra != 0) {
        // [PM55 DSI-guard-dead] unconditional RA update (see emit_load_common).
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// ---------------------------------------------------------------------------
// Const-address MMIO routing.
//
// Ported from Dolphin Jit64's EmuCodeBlock::WriteToConstAddress
// (Source/Core/Core/PowerPC/Jit64Common/EmuCodeBlock.cpp:631-686). When
// the analyzer proved the effective address at compile time, MMIO writes
// (0xCC000000..0xCC03FFFF — GameCube hardware-register window) must
// route DIRECTLY through the host ppc_write* import. The runtime
// MMIO-mirror fast path (live emitter, gekko_emit.cpp:640) is a
// performance hack that lets the host coalesce writes into a SAB mirror;
// for MMIO addresses with side effects (DVDInterface DICR/DICMDBUF,
// AudioInterface, ProcessorInterface…) that coalescing reorders the
// store with respect to subsequent JIT-emitted ops and the host MMIO
// handler — which is exactly the DICR.TSTART-before-DICMDBUF[0] ordering
// failure that triggers DVDInterface.cpp:1286 "Unknown DVD command
// 00000000 - fatal error" on PSO boot.
//
// Const-EA store ordering guarantee: rc.Flush(ctx_ptr) is emitted BEFORE
// the import call (so any dirty GPRs the handler may inspect through
// PowerPCState are coherent), and the import call is a wasm `call` to
// an imported host function — the V8 wasm engine treats imports as
// opaque external calls and is forbidden by the wasm-spec from
// reordering wasm side effects across them. The subsequent JIT-emitted
// op observes the host write's full side effect.
// ---------------------------------------------------------------------------
static constexpr u32 MMIO_BASE = 0xCC000000u;
static constexpr u32 MMIO_END  = 0xCC040000u;

static bool is_mmio_const_addr(u32 addr) {
    return addr >= MMIO_BASE && addr < MMIO_END;
}

// Emit a store to a compile-time-known MMIO address. Stack-neutral.
static void emit_const_mmio_store(WasmModuleBuilder& wb, RegCache& rc,
                                  FPRRegCache& frc,
                                  LoadStoreParams params, u32 addr,
                                  StoreWidth width, u32 src_local) {
    // Flush dirty GPRs to PowerPCState — host MMIO handler may read them
    // (e.g. ExpansionInterface inspects gpr[3..5] for some commands).
    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);
    // Push address + value, call import. The wasm `call` to a host import
    // is a strict happens-before barrier per wasm semantics — no
    // subsequent op can be hoisted across it.
    wb.op_i32_const((s32)addr);
    wb.op_local_get(src_local);
    wb.op_call(write_import_for_width(width));
}

// Emit a load from a compile-time-known MMIO address. Leaves the loaded
// value (sign-extended for S16) on the stack.
// 2026-06-01: callers now inline the body to avoid the Flush-after-Bind
// stale-zero ordering bug; this helper is preserved for future reuse and
// marked maybe_unused.
[[maybe_unused]] static void emit_const_mmio_load(WasmModuleBuilder& wb, RegCache& rc,
                                 FPRRegCache& frc,
                                 LoadStoreParams params, u32 addr,
                                 LoadWidth width) {
    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);
    wb.op_i32_const((s32)addr);
    wb.op_call(read_import_for_width(width));
    if (width == LoadWidth::S16) {
        wb.op_i32_const(16);
        wb.op_i32_shl();
        wb.op_i32_const(16);
        wb.op_i32_shr_s();
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------
void emit_load_d(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    // Compile-time-known address: route MMIO directly through the import,
    // keep non-MMIO on the fastmem path. RAM loads still go through the
    // guarded if/else (BAT/TLB races on MMU enable would otherwise
    // require yet another const-address gate).
    if (op.has_const_ea && is_mmio_const_addr(op.const_ea)) {
        // CRITICAL: Flush dirty regcache BEFORE Bind(rt, Write). Binding rt
        // first marks its wasm-local as the canonical source; the subsequent
        // Flush inside emit_const_mmio_load would then write rt's stale local
        // (default 0) to memory[gpr(rt)] BEFORE the import call produces the
        // loaded value. This is the same stale-zero memory-corruption bug
        // fixed for emit_load_common at 2026-05-31 (commit 4247f98 — see
        // ordering comment at lines 245-260 above). Mirror that ordering
        // here: Flush, then Bind(Write), then perform the load.
        rc.Flush(params.ctx_ptr);
        frc.Flush(params.ctx_ptr);
        auto rc_rt = rc.Bind(rt, RCMode::Write);
        // emit_const_mmio_load also calls rc.Flush internally — a second
        // Flush after Bind(Write) would re-trigger the stale-write bug.
        // Inline its body here (sans the redundant Flush) instead.
        wb.op_i32_const((s32)op.const_ea);
        wb.op_call(read_import_for_width(width));
        if (width == LoadWidth::S16) {
            wb.op_i32_const(16);
            wb.op_i32_shl();
            wb.op_i32_const(16);
            wb.op_i32_shr_s();
        }
        // [C6 2026-07-12 oracle-audit] Park the read value and gate the RT (and
        // update-form RA) commit on !(Exceptions & EXCEPTION_DSI). This MMIO
        // path always uses the host import, which can raise DSI on an
        // unmapped/faulting register access — oracle lbz:46 / lbzu:56-60.
        wb.op_local_set(LOCAL_TMP_FPVAL);
        const u32 rt_local = rc_rt.local_idx();
        // [PM55 DSI-guard-dead] unconditional commit (see emit_load_common).
        wb.op_local_get(LOCAL_TMP_FPVAL);
        wb.op_local_set(rt_local);
        if (update && ra != 0) {
            auto rc_ra = rc.Bind(ra, RCMode::Write);
            wb.op_i32_const((s32)op.const_ea);
            wb.op_local_set(rc_ra.local_idx());
        }
        return;
    }

    emit_ea_d_form(wb, rc, ra, simm, params.ea_cache);   // [PM55 EA-CSE]
    emit_load_common(wb, rc, frc, params, rt, ra, width, update);
}

void emit_store_d(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    // Const-address MMIO store: bypass the fastmem-guarded if/else and
    // route directly to the host import. Preserves the host-observable
    // store ordering required by DVDInterface DICR.TSTART/DICMDBUF[0],
    // AudioInterface, etc.
    if (op.has_const_ea && is_mmio_const_addr(op.const_ea)) {
        auto rc_rs = rc.Bind(rs, RCMode::Read);
        emit_const_mmio_store(wb, rc, frc, params, op.const_ea, width,
                              rc_rs.local_idx());
        // [PM55 DSI-guard-dead] unconditional RA update (see emit_load_common).
        if (update && ra != 0) {
            auto rc_ra = rc.Bind(ra, RCMode::Write);
            wb.op_i32_const((s32)op.const_ea);
            wb.op_local_set(rc_ra.local_idx());
        }
        return;
    }

    emit_ea_d_form(wb, rc, ra, simm, params.ea_cache);   // [PM55 EA-CSE]
    emit_store_common(wb, rc, frc, params, rs, ra, width, update);
}

void emit_load_x(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    emit_ea_x_form(wb, rc, ra, rb);
    emit_load_common(wb, rc, frc, params, rt, ra, width, update);
}

void emit_store_x(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    emit_ea_x_form(wb, rc, ra, rb);
    emit_store_common(wb, rc, frc, params, rs, ra, width, update);
}

// ---------------------------------------------------------------------------
// FP X-form: lfsx / stfsx / stfiwx. All route through WIMPORT_READ32/WRITE32
// without fastmem (FPRs touched in MMIO range is exceedingly rare and the
// f32 reinterpret prelude/postlude is awkward to share with the integer
// fastmem shape). Flush regcache before the call so host MMIO handlers see
// coherent PowerPCState.
// Ported from gekko_emit.cpp:2847-2878.
// ---------------------------------------------------------------------------

// Compute EA = (ra ? gpr[ra] : 0) + gpr[rb] and leave it on the wasm stack.
static void emit_ea_x_stack(WasmModuleBuilder& wb, RegCache& rc,
                            u32 ra, u32 rb) {
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    if (ra == 0) {
        wb.op_local_get(rc_rb.local_idx());
    } else {
        auto rc_ra = rc.Bind(ra, RCMode::Read);
        wb.op_local_get(rc_ra.local_idx());
        wb.op_local_get(rc_rb.local_idx());
        wb.op_i32_add();
    }
}

// [lfs-single PM25] Fastmem-guarded scalar f32 load producing SINGLE repr:
// the raw f32 bits go straight into the rt v128 as [x,x,x,x] — NO widen at
// all (NaN payload trivially preserved; the flush's EmitPromoteToDouble uses
// the same PEM-exact splice the old [C9] tail used, so ps[] memory stays
// bit-identical). Making lfs produce Single is step 1 of the single-valued
// speculation chain (TASKS.md PM25): the IDCT's lfs-loaded constants must
// flush through the Single path so the shadow mask can mark them f32-valued.
// Precondition: EA in LOCAL_TMP_EA, rc flushed. The loaded (byte-swapped)
// u32 is parked in LOCAL_TMP_FPVAL (NOT LOCAL_TMP_VAL: guard + bswap clobber
// it; emit_slowmem_load_value also uses TMP_VAL internally).
static void emit_fastmem_lfs_body_single(WasmModuleBuilder& wb,
                                         LoadStoreParams params,
                                         FPRRegCache& frc, u32 rt) {
    emit_fastmem_guard(wb, params, 4);
    wb.op_if(BLOCK_TYPE_VOID);
        emit_fastmem_load_value(wb, params, LoadWidth::U32);   // fast: i32.load+bswap
        wb.op_local_set(LOCAL_TMP_FPVAL);
    wb.op_else();
        emit_slowmem_load_value(wb, params, LoadWidth::U32);   // LC arm + import
        wb.op_local_set(LOCAL_TMP_FPVAL);
    wb.op_end();
    auto rt_s = frc.BindSingleWrite(rt);
    wb.op_local_get(LOCAL_TMP_FPVAL);
    wb.op_f32_reinterpret_i32();
    wb.op_f32x4_splat();                       // [x,x,x,x] — ps0 == ps1 == x
    wb.op_local_set(rt_s.v128_idx);
}

// [perf] Fastmem-guarded f64 LOAD (8 bytes BE) into the rt ps0 i64 lane.
// Precondition: EA in LOCAL_TMP_EA, rc/frc flushed, rt bound. The fast arm
// computes the host base once (into LOCAL_TMP_FPVAL) and does two i32.load +
// bswap (offsets 0/4); the slow arm keeps the two WIMPORT_READ32 calls. Both
// build the same big-endian i64 (hi = bytes 0..3 logical << 32 | lo = 4..7).
static void emit_fastmem_lfd_body(WasmModuleBuilder& wb, LoadStoreParams params,
                                  u32 ps0_idx) {
    emit_fastmem_guard(wb, params, 8);
    wb.op_if(BLOCK_TYPE_VOID);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_i32_const((s32)params.mem1_mask);
        wb.op_i32_and();
        wb.op_i32_const((s32)params.mem1_base);
        wb.op_i32_add();
        wb.op_local_set(LOCAL_TMP_FPVAL);       // host base addr
        wb.op_local_get(LOCAL_TMP_FPVAL);
        wb.op_i32_load(0);
        emit_bswap_i32(wb);
        wb.op_i64_extend_i32_u();
        wb.op_i64_const(32);
        wb.op_i64_shl();
        wb.op_local_get(LOCAL_TMP_FPVAL);
        wb.op_i32_load(4);
        emit_bswap_i32(wb);
        wb.op_i64_extend_i32_u();
        wb.op_i64_or();
        wb.op_local_set(ps0_idx);
    wb.op_else();
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_call(WIMPORT_READ32);
        wb.op_i64_extend_i32_u();
        wb.op_i64_const(32);
        wb.op_i64_shl();
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_i32_const(4);
        wb.op_i32_add();
        wb.op_call(WIMPORT_READ32);
        wb.op_i64_extend_i32_u();
        wb.op_i64_or();
        wb.op_local_set(ps0_idx);
    wb.op_end();
}

// [perf] Fastmem-guarded f64 STORE (8 bytes BE) from the rs ps0 i64 lane.
// Fast arm: two bswap + i32.store (offsets 0/4); slow arm: two WIMPORT_WRITE32.
static void emit_fastmem_stfd_body(WasmModuleBuilder& wb, LoadStoreParams params,
                                   u32 rs_ps0_idx) {
    emit_fastmem_guard(wb, params, 8);
    wb.op_if(BLOCK_TYPE_VOID);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_i32_const((s32)params.mem1_mask);
        wb.op_i32_and();
        wb.op_i32_const((s32)params.mem1_base);
        wb.op_i32_add();
        wb.op_local_set(LOCAL_TMP_FPVAL);       // host base addr
        wb.op_local_get(LOCAL_TMP_FPVAL);       // addr (bytes 0..3)
        wb.op_local_get(rs_ps0_idx);
        wb.op_i64_const(32);
        wb.op_i64_shr_u();
        wb.op_i32_wrap_i64();
        emit_bswap_i32(wb);
        wb.op_i32_store(0);
        wb.op_local_get(LOCAL_TMP_FPVAL);       // addr+4 (bytes 4..7)
        wb.op_local_get(rs_ps0_idx);
        wb.op_i32_wrap_i64();
        emit_bswap_i32(wb);
        wb.op_i32_store(4);
    wb.op_else();
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_get(rs_ps0_idx);
        wb.op_i64_const(32);
        wb.op_i64_shr_u();
        wb.op_i32_wrap_i64();
        wb.op_call(WIMPORT_WRITE32);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_i32_const(4);
        wb.op_i32_add();
        wb.op_local_get(rs_ps0_idx);
        wb.op_i32_wrap_i64();
        wb.op_call(WIMPORT_WRITE32);
    wb.op_end();
}

// lfsx fT, rA, rB — load f32 at EA, promote to f64, store at ps0(rt) +
// splat to ps1(rt). Cache-local form: write the promoted f64 (as i64 bits)
// to both ps0 and ps1 cache locals. No memory traffic for the FPR side;
// memory becomes canonical at block-exit frc.Flush.
void emit_lfsx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    // Compute EA to stack, save into LOCAL_TMP_EA.
    emit_ea_x_stack(wb, rc, ra, rb);
    wb.op_local_set(LOCAL_TMP_EA);

    // Flush GPRs (host MMIO handler may inspect them). [lfs-single PM25] NO
    // frc.Flush — same flush-narrow rationale as psq_l/psq_st/integer paths:
    // the host READ handler never reads ps[], and exception/HLE/exit points
    // re-flush; the old per-lfs flush promoted every dirty Single to Double.
    rc.Flush(params.ctx_ptr);

    emit_fastmem_lfs_body_single(wb, params, frc, rt);
}

// emit_convert_to_single — push ConvertToSingle(ps0_bits) as i32.
// Bit-exact port of Dolphin Interpreter_FPUtils.h:541-562 (the stfs/stfsu/
// stfsx store conversion; NOT the FTZ variant used by psq_st):
//   exp = (x >> 52) & 0x7ff
//   fast   (exp > 896 || mag == 0, and the "undefined" exp < 874 case —
//           both branches are the same formula):
//          ((x>>32) & 0xC0000000) | ((x>>29) & 0x3FFFFFFF)
//   denorm (874 <= exp <= 896 && mag != 0):
//          ((0x80000000 | ((x & DOUBLE_FRAC) >> 21)) >> (905 - exp))
//          | ((x>>32) & 0x80000000)
// Branchless via wasm `select` — both values computed, condition picks.
// In the discarded fast case the denorm shift amount may exceed 31; wasm
// i32.shr_u masks the count (&31), so it cannot trap. Clobbers
// LOCAL_TMP_VAL (exp scratch); ps0_local is an i64 FPR cache local.
// Non-static as of [single-spec PM26]: FPRRegCache::EmitAssumedSingleLoads
// uses it as the exact inverse of the PEM widen (round-trip identity incl.
// NaN payloads + single denormals — f32.demote_f64 would canonicalize NaNs).
void emit_convert_to_single(WasmModuleBuilder& wb, u32 ps0_local) {
    // exp -> LOCAL_TMP_VAL
    wb.op_local_get(ps0_local);
    wb.op_i64_const(52);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x7FF);
    wb.op_i32_and();
    wb.op_local_set(LOCAL_TMP_VAL);

    // denorm value
    wb.op_local_get(ps0_local);
    wb.op_i64_const(0x000FFFFFFFFFFFFFll);  // Common::DOUBLE_FRAC
    wb.op_i64_and();
    wb.op_i64_const(21);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const((s32)0x80000000u);
    wb.op_i32_or();
    wb.op_i32_const(905);
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_sub();
    wb.op_i32_shr_u();
    wb.op_local_get(ps0_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const((s32)0x80000000u);
    wb.op_i32_and();
    wb.op_i32_or();

    // fast value
    wb.op_local_get(ps0_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const((s32)0xC0000000u);
    wb.op_i32_and();
    wb.op_local_get(ps0_local);
    wb.op_i64_const(29);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x3FFFFFFF);
    wb.op_i32_and();
    wb.op_i32_or();

    // cond: (exp >= 874) & (exp <= 896) & (magnitude != 0)
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(874);
    wb.op_i32_ge_u();
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(896);
    wb.op_i32_le_u();
    wb.op_i32_and();
    // mag != 0: ((wrap(x>>32) & 0x7FFFFFFF) | wrap(x)) != 0 — no i64.eqz
    // in the builder, so do it in i32 halves.
    wb.op_local_get(ps0_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x7FFFFFFF);
    wb.op_i32_and();
    wb.op_local_get(ps0_local);
    wb.op_i32_wrap_i64();
    wb.op_i32_or();
    wb.op_i32_eqz();
    wb.op_i32_eqz();
    wb.op_i32_and();

    wb.op_select();  // cond ? denorm : fast
}

// stfsx fS, rA, rB — store f32 from ps0(rs) at EA, PEM ConvertToSingle
// semantics (2026-06-11: native emit replaces the interp-fallback stub;
// the conversion lives in emit_convert_to_single above).
void emit_stfsx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    emit_ea_x_stack(wb, rc, ra, rb);
    wb.op_local_set(LOCAL_TMP_EA);

    auto rs_pair = frc.Bind(rs, FPRMode::Read, FPR_LANE_PS0);

    // [perf] fastmem fast-arm (was unconditional WIMPORT_WRITE32 — every
    // RAM-resident f32 store crossed wasm->JS). WPAR (0xCC008000) and all MMIO
    // are rejected by the region classifier so GP/MMIO writes still take the
    // slow import arm (preserving gp_dirty_check / FIFO ordering).
    // [m00-hunt FIX PM37 2026-07-23] The flushes MUST run BEFORE the value is
    // parked in LOCAL_TMP_FPVAL (98): frc.Flush's value-unknown round-trip
    // check (fpr_reg_cache.cpp:268) writes LOCAL_PSQ_T0 == slot 98, destroying
    // a value parked across it. That clobber zeroed PSMTXScale's stfs of
    // scale_x=1.0 -> temp.m00=0 -> group matrices collapse -> the MP4 black
    // canvas. Post-flush the ps0 local is still valid (a Single-repr rs was
    // just PROMOTED, which rebuilds the pair locals), so converting here reads
    // the identical value.
    rc.Flush(params.ctx_ptr);   // host WRITE32 (slow arm) may read gpr[]
    frc.Flush(params.ctx_ptr);
    emit_convert_to_single(wb, rs_pair.ps0_idx);   // single bits -> stack
    wb.op_local_set(LOCAL_TMP_FPVAL);

    emit_fastmem_guard(wb, params, 4);
    wb.op_if(BLOCK_TYPE_VOID);
    emit_fastmem_store(wb, params, StoreWidth::U32, LOCAL_TMP_FPVAL);
    wb.op_else();
    emit_slowmem_store(wb, params, StoreWidth::U32, LOCAL_TMP_FPVAL);
    wb.op_end();
}

// stfs  fS, d(rA) — D-form single store, PEM ConvertToSingle semantics.
// stfsu fS, d(rA) — update form: rA <- EA after the store.
// 2026-06-11: native emit (was interp fallback "deferred, needs PEM
// ConvertToSingle"). stfs is every single-precision float store the guest
// makes — the highest-frequency FP fallback in gameplay code paths.
void emit_stfs(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    emit_ea_d_form(wb, rc, ra, simm);  // EA -> LOCAL_TMP_EA

    auto rs_pair = frc.Bind(rs, FPRMode::Read, FPR_LANE_PS0);

    // [perf] fastmem fast-arm — see emit_stfsx. stfs is the highest-frequency
    // FP store the guest makes; this removes the per-store wasm->JS crossing
    // for RAM-resident f32s (matrix/vertex data), MMIO still slow-pathed.
    // [m00-hunt FIX PM37 2026-07-23] flushes FIRST — see emit_stfsx: parking
    // across frc.Flush let its value-unknown check (slot 98 == LOCAL_TMP_FPVAL)
    // destroy the store value. THE MP4 black-canvas root fix.
    rc.Flush(params.ctx_ptr);   // host WRITE32 (slow arm) may read gpr[]
    frc.Flush(params.ctx_ptr);
    emit_convert_to_single(wb, rs_pair.ps0_idx);   // single bits -> stack
    wb.op_local_set(LOCAL_TMP_FPVAL);

    emit_fastmem_guard(wb, params, 4);
    wb.op_if(BLOCK_TYPE_VOID);
    emit_fastmem_store(wb, params, StoreWidth::U32, LOCAL_TMP_FPVAL);
    wb.op_else();
    emit_slowmem_store(wb, params, StoreWidth::U32, LOCAL_TMP_FPVAL);
    wb.op_end();

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// lfd  FRD, d(rA)  — load f64 (8 bytes BE) from EA, store at ps0(FRD).
// lfdu FRD, d(rA)  — same + rA <- EA (update form, opc 51).
// Slowmem-only path (no fastmem): two WIMPORT_READ32 calls (each host
// byte-swaps its u32), combined into i64 with high u32 in upper bits and
// low u32 in lower bits, then f64_reinterpret_i64 + f64_store directly to
// the PowerPCState mirror. No FPR cache.
//
// Per mp4_wedge_is_throughput_2026_06_07: every gcsetjmp/gclongjmp pays
// 18 of these via interp fallback (~18×WIMPORT_INTERP roundtrips). Native
// emit is the documented throughput fix path. Per FP audit researcher
// 2026-06-08: structurally mirrors emit_lfsx but for 8 bytes.
void emit_lfd(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
              LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    emit_ea_d_form(wb, rc, ra, simm);  // EA -> LOCAL_TMP_EA

    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);

    // Bind rt for Write — only ps0 lane (lfd does NOT splat to ps1; ps1 is
    // preserved per scalar-FP semantics, unlike lfsx/lfs which DO splat).
    auto rt_pair = frc.Bind(rt, FPRMode::Write, FPR_LANE_PS0);
    // [single-spec v5] lfd loads arbitrary memory — value unknown until the
    // flush's runtime widened-single check (the __OSLoadFPUContext restore
    // path that was clearing the IDCT constants' mask bits).
    frc.MarkValueUnknown(rt);

    emit_fastmem_lfd_body(wb, params, rt_pair.ps0_idx);

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// stfd  FRS, d(rA) — store f64 from ps0(FRS) at EA (8 bytes BE).
// stfdu FRS, d(rA) — same + rA <- EA (update form, opc 55).
//
// Cache-local form: read the i64 from rs's ps0 cache local (the i64
// equals the big-endian guest's 8-byte value reinterpreted to host LE
// bits — same as the f64 stored in memory before). Extract halves via
// i64.shr / i64.wrap. The high i64 bits = guest BYTES 0..3; the low
// i64 bits = guest BYTES 4..7. WIMPORT_WRITE32 byte-swaps host LE u32 →
// guest BE bytes, so:
//   write32(EA,     wrap(local >> 32)) → EA..EA+3 = guest BYTES 0..3
//   write32(EA + 4, wrap(local))       → EA+4..EA+7 = guest BYTES 4..7
//
// Eliminates the latent stale-memory bug: when rs's ps0 lane is dirty in
// the cache, the prior code read memory ps0(rs)+0/+4 — which held the
// pre-write value. The fix is structural: read the local, which always
// holds the current value.
void emit_stfd(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    emit_ea_d_form(wb, rc, ra, simm);  // EA -> LOCAL_TMP_EA

    // Read rs's ps0 lane from cache. No frc.Flush needed for the source
    // (we're reading from the local, not memory).
    auto rs_pair = frc.Bind(rs, FPRMode::Read, FPR_LANE_PS0);

    // GPR flush — host WRITE32 (slow arm) may dispatch into MMIO that reads gpr[].
    rc.Flush(params.ctx_ptr);

    emit_fastmem_stfd_body(wb, params, rs_pair.ps0_idx);

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}


// ---------------------------------------------------------------------------
// psq_l / psq_st — native paired-single quantized load/store (D-forms,
// opcd 56/57/60/61). Bit-exact reference: Interpreter_LoadStorePaired.cpp
// (ILSP). Documented divergences (header comment): no HID2.PSE/LSQE gate
// (Jit64 parity — Jit64 emits none); DSI handling follows the lfs/stfs
// precedent (no gate; queued with the update-form RA audit item). GQR is a
// RUNTIME load every execution — no constant-GQR speculation (mtspr GQR is
// an interp fallback mutating spr[] mid-block).
// ---------------------------------------------------------------------------

// Extra scratch appended as the 4th locals group by build_block_next:
// two i32 pair-element stages + one f64 clamp stage.
static constexpr u32 LOCAL_PSQ_T0  = 98;
static constexpr u32 LOCAL_PSQ_T1  = 99;
static constexpr u32 LOCAL_PSQ_F64 = 100;

// Push ConvertToDouble(f32 bits in LOCAL_PSQ_T0) as i64. ILSP:237 uses the
// PEM widening that PRESERVES NaN payloads (incl. the SNaN quiet bit) while
// wasm f64.promote_f32 may canonicalize NaNs (spec-permitted). Promote is
// IEEE-bit-exact for normal/zero/subnormal/inf, so: promote for the common
// case, integer splice for exp==255 (FPU:607-612 arm, y=1 -> z=0x7<<59:
// ((x&0xc0000000)<<32) | z | ((x&0x3fffffff)<<29)) — also exact for inf.
// Non-static: also used by jit_floating_point.cpp (op59 singles / frsp)
// to widen the ForceSingle result back to the f64 register format.
void emit_psq_convert_to_double(WasmModuleBuilder& wb) {
    // splice value (exp==255 arm)
    wb.op_local_get(LOCAL_PSQ_T0);
    wb.op_i64_extend_i32_u();
    wb.op_i64_const((s64)0xC0000000ll);
    wb.op_i64_and();
    wb.op_i64_const(32);
    wb.op_i64_shl();
    wb.op_i64_const(0x3800000000000000ll);  // 0x7 << 59
    wb.op_i64_or();
    wb.op_local_get(LOCAL_PSQ_T0);
    wb.op_i64_extend_i32_u();
    wb.op_i64_const(0x3FFFFFFFll);
    wb.op_i64_and();
    wb.op_i64_const(29);
    wb.op_i64_shl();
    wb.op_i64_or();
    // promote value
    wb.op_local_get(LOCAL_PSQ_T0);
    wb.op_f32_reinterpret_i32();
    wb.op_f64_promote_f32();
    wb.op_i64_reinterpret_f64();
    // cond: exp == 255 -> pick splice
    wb.op_local_get(LOCAL_PSQ_T0);
    wb.op_i32_const(23);
    wb.op_i32_shr_u();
    wb.op_i32_const(0xFF);
    wb.op_i32_and();
    wb.op_i32_const(0xFF);
    wb.op_i32_eq();
    wb.op_select();
}

// Push ConvertToSingleFTZ(ps_local) as i32 (ILSP:159; FPU:565-577):
//   (exp > 896 || magnitude == 0) -> ((x>>32)&0xC0000000)|((x>>29)&0x3FFFFFFF)
//   else                          -> (x>>32)&0x80000000  (flush to signed 0)
static void emit_convert_to_single_ftz(WasmModuleBuilder& wb, u32 ps_local) {
    // fast value (val1)
    wb.op_local_get(ps_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const((s32)0xC0000000u);
    wb.op_i32_and();
    wb.op_local_get(ps_local);
    wb.op_i64_const(29);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x3FFFFFFF);
    wb.op_i32_and();
    wb.op_i32_or();
    // sign-only flush value (val2)
    wb.op_local_get(ps_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const((s32)0x80000000u);
    wb.op_i32_and();
    // cond: exp > 896 || mag == 0 -> pick fast
    wb.op_local_get(ps_local);
    wb.op_i64_const(52);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x7FF);
    wb.op_i32_and();
    wb.op_i32_const(896);
    wb.op_i32_gt_u();
    wb.op_local_get(ps_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x7FFFFFFF);
    wb.op_i32_and();
    wb.op_local_get(ps_local);
    wb.op_i32_wrap_i64();
    wb.op_i32_or();
    wb.op_i32_eqz();
    wb.op_i32_or();
    wb.op_select();
}

// Push the scale factor as f32 from a 6-bit scale field on the stack:
// dequantize factor = 2^-scale (f32 bits (127-sext6(s))<<23), quantize =
// 2^scale ((127+sext6(s))<<23). scale in [-32,31] -> exponent stays normal.
static void emit_psq_factor_from_scale(WasmModuleBuilder& wb, bool quantize) {
    wb.op_i32_const(26);
    wb.op_i32_shl();
    wb.op_i32_const(26);
    wb.op_i32_shr_s();
    if (quantize) {
        wb.op_i32_const(127);
        wb.op_i32_add();
    } else {
        wb.op_i32_const(-1);
        wb.op_i32_mul();
        wb.op_i32_const(127);
        wb.op_i32_add();
    }
    wb.op_i32_const(23);
    wb.op_i32_shl();
    wb.op_f32_reinterpret_i32();
}

// Clamp LOCAL_PSQ_F64 to [lo, hi] in place. Bounds are exactly
// f32-representable; f64 comparison of f32-valued data gives identical
// ordering to the interpreter's f32-domain std::clamp. NaN survives both
// selects (comparisons false keep it) and trunc_sat maps it to 0 — equal
// to the interpreter's host cast (0x80000000) truncated to any psq width.
static void emit_psq_clamp_f64(WasmModuleBuilder& wb, double lo, double hi) {
    // x = (x > hi) ? hi : x
    wb.op_f64_const(hi);
    wb.op_local_get(LOCAL_PSQ_F64);
    wb.op_local_get(LOCAL_PSQ_F64);
    wb.op_f64_const(hi);
    wb.op_f64_gt();
    wb.op_select();
    wb.op_local_set(LOCAL_PSQ_F64);
    // x = (x < lo) ? lo : x
    wb.op_f64_const(lo);
    wb.op_local_get(LOCAL_PSQ_F64);
    wb.op_local_get(LOCAL_PSQ_F64);
    wb.op_f64_const(lo);
    wb.op_f64_lt();
    wb.op_select();
    wb.op_local_set(LOCAL_PSQ_F64);
}

void emit_psq_l(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rt = GekkoOperands::RD(inst);
    const u32 ra = GekkoOperands::RA(inst);
    const u32 W  = (inst >> 15) & 1u;
    const u32 I  = (inst >> 12) & 7u;
    const u32 simm12 = (u32)(((s32)(inst << 20)) >> 20);

    emit_ea_d_form(wb, rc, ra, simm12);
    rc.Flush(params.ctx_ptr);
    // [flush-narrow 2026-07-23] NO frc.Flush — same rationale as emit_store_common /
    // emit_psq_st: the slow arm's host READ handler (dolphin_read*) reads gpr[] but
    // never ps[]/FPRs, and every exception/HLE/block-exit point re-flushes FPRs
    // itself. The old per-psq_l frc.Flush promoted EVERY dirty Single FPR to Double
    // (~70 ops each) and poisoned the repr, so in psq_l-interleaved paired code
    // (THP IDCT __THPDecompressiMCURowNxN: 192 psq_l among 938 ps arith ops) the
    // jit_paired SIMD paths never fired — the measured 33.7x-vs-native root.
    // rc.Flush (GPRs) stays: host handlers do inspect gpr[].

    // [psq raw-f32 2026-07-13] Each arm below leaves the EXACT f32 BIT pattern it previously fed
    // to emit_psq_convert_to_double in LOCAL_PSQ_T0 (ps0 lane) / LOCAL_PSQ_T1 (ps1 lane); the
    // Single v128 is built ONCE at the end via f32.reinterpret_i32 — NO f64 promote/demote
    // round-trip (the residual cost prior analysis named for the FP-heavy paired-single paths).
    // Bit-identical to the old path for all finite values; NaN payloads are now PRESERVED rather
    // than canonicalized by the old f32.demote_f64 in Phase 3 — strictly closer to the ILSP
    // oracle (which loads the raw f32). No i64 rt bind; frc.BindSingleWrite at the end.

    // [psq-gqr-spec PM50 2026-08-03] FLOAT-load specialization, mirroring the
    // psq_st arm (PM48b): live GQR read at emit; when the ld half is FLOAT,
    // a full-equality guard selects a body with the runtime type dispatch
    // gone. The MP4 IDCT's 8 GQR0 float loads per iteration are the target.
    bool gqr_l_specialized = false;
    if (g_bem_lc_base) {
        const u32 gqr_live = *reinterpret_cast<volatile u32*>(
            static_cast<uintptr_t>(params.ctx_ptr + ppc_off::spr(912u + I)));
        if (((gqr_live >> 16) & 7u) == 0u) {   // ld_type == FLOAT
            gqr_l_specialized = true;
            wb.op_i32_const((s32)params.ctx_ptr);
            wb.op_i32_load(ppc_off::spr(912u + I));
            wb.op_i32_const((s32)gqr_live);
            wb.op_i32_eq();
            wb.op_if(BLOCK_TYPE_VOID);
            {
                // exact mirror of the generic FLOAT arm below.
                if (W) {
                    emit_fastmem_guard(wb, params, 4);
                    wb.op_if(BLOCK_TYPE_VOID);
                        emit_fastmem_load_value(wb, params, LoadWidth::U32);
                        wb.op_local_set(LOCAL_PSQ_T0);
                    wb.op_else();
                        wb.op_local_get(LOCAL_TMP_EA);
                        wb.op_call(WIMPORT_READ32);
                        wb.op_local_set(LOCAL_PSQ_T0);
                    wb.op_end();
                    wb.op_i32_const((s32)0x3F800000);
                    wb.op_local_set(LOCAL_PSQ_T1);
                } else {
                    emit_fastmem_guard(wb, params, 8);
                    wb.op_if(BLOCK_TYPE_VOID);
                        wb.op_local_get(LOCAL_TMP_EA);
                        wb.op_i32_const((s32)params.mem1_mask);
                        wb.op_i32_and();
                        wb.op_i32_const((s32)params.mem1_base);
                        wb.op_i32_add();
                        wb.op_local_tee(LOCAL_PSQ_T1);
                        wb.op_i32_load(0);
                        emit_bswap_i32(wb);
                        wb.op_local_set(LOCAL_PSQ_T0);
                        wb.op_local_get(LOCAL_PSQ_T1);
                        wb.op_i32_load(4);
                        emit_bswap_i32(wb);
                        wb.op_local_set(LOCAL_PSQ_T1);
                    wb.op_else();
                        wb.op_local_get(LOCAL_TMP_EA);
                        wb.op_call(WIMPORT_READ32);
                        wb.op_local_set(LOCAL_PSQ_T0);
                        wb.op_local_get(LOCAL_TMP_EA);
                        wb.op_i32_const(4);
                        wb.op_i32_add();
                        wb.op_call(WIMPORT_READ32);
                        wb.op_local_set(LOCAL_PSQ_T1);
                    wb.op_end();
                }
            }
            wb.op_else();   // GQR changed — generic body below
        }
    }

    // gqr -> LOCAL_TMP_VAL (ld_type bits 16-18, ld_scale 24-29)
    wb.op_i32_const((s32)params.ctx_ptr);
    wb.op_i32_load(ppc_off::spr(912u + I));
    wb.op_local_set(LOCAL_TMP_VAL);

    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(16);
    wb.op_i32_shr_u();
    wb.op_i32_const(7);
    wb.op_i32_and();
    wb.op_i32_eqz();
    wb.op_if(BLOCK_TYPE_VOID);
    {
        // FLOAT: raw f32 patterns, no scale (ILSP:233-246). fastmem-guarded.
        if (W) {
            emit_fastmem_guard(wb, params, 4);
            wb.op_if(BLOCK_TYPE_VOID);
                emit_fastmem_load_value(wb, params, LoadWidth::U32);
                wb.op_local_set(LOCAL_PSQ_T0);      // ps0 f32 bits
            wb.op_else();
                wb.op_local_get(LOCAL_TMP_EA);
                wb.op_call(WIMPORT_READ32);
                wb.op_local_set(LOCAL_PSQ_T0);
            wb.op_end();
            wb.op_i32_const((s32)0x3F800000);       // ps1 = 1.0f bits (ILSP:238)
            wb.op_local_set(LOCAL_PSQ_T1);
        } else {
            emit_fastmem_guard(wb, params, 8);
            wb.op_if(BLOCK_TYPE_VOID);
                // host base -> T1; lane0 bits -> T0; lane1 bits -> T1 (base free after).
                wb.op_local_get(LOCAL_TMP_EA);
                wb.op_i32_const((s32)params.mem1_mask);
                wb.op_i32_and();
                wb.op_i32_const((s32)params.mem1_base);
                wb.op_i32_add();
                wb.op_local_tee(LOCAL_PSQ_T1);          // host base addr
                wb.op_i32_load(0);
                emit_bswap_i32(wb);
                wb.op_local_set(LOCAL_PSQ_T0);          // ps0 f32 bits
                wb.op_local_get(LOCAL_PSQ_T1);
                wb.op_i32_load(4);
                emit_bswap_i32(wb);
                wb.op_local_set(LOCAL_PSQ_T1);          // ps1 f32 bits (base overwritten)
            wb.op_else();
                wb.op_local_get(LOCAL_TMP_EA);
                wb.op_call(WIMPORT_READ32);
                wb.op_local_set(LOCAL_PSQ_T0);          // ps0 f32 bits
                wb.op_local_get(LOCAL_TMP_EA);
                wb.op_i32_const(4);
                wb.op_i32_add();
                wb.op_call(WIMPORT_READ32);
                wb.op_local_set(LOCAL_PSQ_T1);          // ps1 f32 bits
            wb.op_end();
        }
    }
    wb.op_else();
    {
        wb.op_local_get(LOCAL_TMP_VAL);
        wb.op_i32_const(16);
        wb.op_i32_shr_u();
        wb.op_i32_const(4);
        wb.op_i32_and();
        wb.op_if(BLOCK_TYPE_VOID);
        {
            // U8/U16/S8/S16. Pair = ONE wide access (ILSP ReadPair):
            // u8 pair -> read16 (ps0 = hi byte); u16 pair -> read32.
            wb.op_local_get(LOCAL_TMP_VAL);
            wb.op_i32_const(16);
            wb.op_i32_shr_u();
            wb.op_i32_const(1);
            wb.op_i32_and();
            wb.op_if(BLOCK_TYPE_VOID);
            {   // 16-bit elements
                // [psq-quant-fastmem 2026-07-23] Guarded raw-load arm mirrors the
                // FLOAT path: the quantized arms previously called the import
                // UNCONDITIONALLY, so every S16 coefficient psq_l in the THP IDCT
                // (plain RAM __THPMCUBuffer, GQR5) crossed the instance boundary —
                // the named source class of the 67.4M slow RAM-mirror calls.
                // Dequant stays in-wasm below either way. MMIO/LC still reject to
                // the import via the region classifier.
                if (W) {
                    emit_fastmem_guard(wb, params, 2);
                    wb.op_if(BLOCK_TYPE_VOID);
                        emit_fastmem_load_value(wb, params, LoadWidth::U16);
                        wb.op_local_set(LOCAL_PSQ_T0);
                    wb.op_else();
                        emit_slowmem_load_value(wb, params, LoadWidth::U16);
                        wb.op_local_set(LOCAL_PSQ_T0);
                    wb.op_end();
                } else {
                    emit_fastmem_guard(wb, params, 4);
                    wb.op_if(BLOCK_TYPE_VOID);
                        emit_fastmem_load_value(wb, params, LoadWidth::U32);
                        wb.op_local_set(LOCAL_PSQ_T1);
                    wb.op_else();
                        emit_slowmem_load_value(wb, params, LoadWidth::U32);
                        wb.op_local_set(LOCAL_PSQ_T1);
                    wb.op_end();
                    wb.op_local_get(LOCAL_PSQ_T1);
                    wb.op_i32_const(16);
                    wb.op_i32_shr_u();
                    wb.op_local_set(LOCAL_PSQ_T0);
                    wb.op_local_get(LOCAL_PSQ_T1);
                    wb.op_i32_const(0xFFFF);
                    wb.op_i32_and();
                    wb.op_local_set(LOCAL_PSQ_T1);
                }
            }
            wb.op_else();
            {   // 8-bit elements
                if (W) {
                    emit_fastmem_guard(wb, params, 1);
                    wb.op_if(BLOCK_TYPE_VOID);
                        emit_fastmem_load_value(wb, params, LoadWidth::U8);
                        wb.op_local_set(LOCAL_PSQ_T0);
                    wb.op_else();
                        emit_slowmem_load_value(wb, params, LoadWidth::U8);
                        wb.op_local_set(LOCAL_PSQ_T0);
                    wb.op_end();
                } else {
                    emit_fastmem_guard(wb, params, 2);
                    wb.op_if(BLOCK_TYPE_VOID);
                        emit_fastmem_load_value(wb, params, LoadWidth::U16);
                        wb.op_local_set(LOCAL_PSQ_T1);
                    wb.op_else();
                        emit_slowmem_load_value(wb, params, LoadWidth::U16);
                        wb.op_local_set(LOCAL_PSQ_T1);
                    wb.op_end();
                    wb.op_local_get(LOCAL_PSQ_T1);
                    wb.op_i32_const(8);
                    wb.op_i32_shr_u();
                    wb.op_i32_const(0xFF);
                    wb.op_i32_and();
                    wb.op_local_set(LOCAL_PSQ_T0);
                    wb.op_local_get(LOCAL_PSQ_T1);
                    wb.op_i32_const(0xFF);
                    wb.op_i32_and();
                    wb.op_local_set(LOCAL_PSQ_T1);
                }
            }
            wb.op_end();

            // [psq-quant-fastmem] emit_bswap_i32/i16 (inside the fast arms above)
            // use LOCAL_TMP_VAL as scratch, clobbering the GQR image the sign/scale
            // code below still reads. Re-load it (value unchanged — no guest op ran).
            wb.op_i32_const((s32)params.ctx_ptr);
            wb.op_i32_load(ppc_off::spr(912u + I));
            wb.op_local_set(LOCAL_TMP_VAL);

            const u32 lanes[2] = { LOCAL_PSQ_T0, LOCAL_PSQ_T1 };
            const u32 nlanes = W ? 1u : 2u;
            for (u32 ln = 0; ln < nlanes; ++ln) {
                // signed? sign-extend the element in place (shl/shr_s pair)
                wb.op_local_get(LOCAL_TMP_VAL);
                wb.op_i32_const(16);
                wb.op_i32_shr_u();
                wb.op_i32_const(2);
                wb.op_i32_and();
                wb.op_if(BLOCK_TYPE_VOID);
                {
                    wb.op_local_get(LOCAL_TMP_VAL);
                    wb.op_i32_const(16);
                    wb.op_i32_shr_u();
                    wb.op_i32_const(1);
                    wb.op_i32_and();
                    wb.op_if(BLOCK_TYPE_VOID);
                    {
                        wb.op_local_get(lanes[ln]);
                        wb.op_i32_const(16);
                        wb.op_i32_shl();
                        wb.op_i32_const(16);
                        wb.op_i32_shr_s();
                        wb.op_local_set(lanes[ln]);
                    }
                    wb.op_else();
                    {
                        wb.op_local_get(lanes[ln]);
                        wb.op_i32_const(24);
                        wb.op_i32_shl();
                        wb.op_i32_const(24);
                        wb.op_i32_shr_s();
                        wb.op_local_set(lanes[ln]);
                    }
                    wb.op_end();
                }
                wb.op_end();

                // ps = f64( f32(elem) * 2^-scale ). Signed i32->f32 convert
                // is exact for the unsigned elements too (<= 65535).
                wb.op_local_get(lanes[ln]);
                wb.op_f32_convert_i32_s();
                wb.op_local_get(LOCAL_TMP_VAL);
                wb.op_i32_const(24);
                wb.op_i32_shr_u();
                wb.op_i32_const(0x3F);
                wb.op_i32_and();
                emit_psq_factor_from_scale(wb, /*quantize=*/false);
                wb.op_f32_mul();
                wb.op_i32_reinterpret_f32();            // f32 bits (no f64 round-trip)
                wb.op_local_set(lanes[ln]);
            }
            if (W) {
                wb.op_i32_const((s32)0x3F800000);       // ps1 = 1.0f bits
                wb.op_local_set(LOCAL_PSQ_T1);
            }
        }
        wb.op_else();
        {
            // INVALID1/2/3: ps0 = ps1 = 0.0f, NO memory access (ILSP:264-270)
            wb.op_i32_const(0);
            wb.op_local_set(LOCAL_PSQ_T0);
            wb.op_i32_const(0);
            wb.op_local_set(LOCAL_PSQ_T1);
        }
        wb.op_end();
    }
    wb.op_end();

    // [psq-gqr-spec PM50] close the FLOAT-specialization guard around the generic tree.
    if (gqr_l_specialized)
        wb.op_end();

    // [psq raw-f32 2026-07-13] Build the Single v128 [ps0,ps1,ps0,ps0] from the lane f32 BITS in
    // T0/T1 — one splat + one replace_lane, zero f64 promote/demote. rt is tagged Single so the
    // jit_paired ps_add/sub/mul/FMA consumers (movie IDCT __THPDecompressiMCURowNxN, matrix code)
    // take the wasm-SIMD f32x2 fast path. Memory reconciliation at flush goes through
    // EmitPromoteToDouble (NaN-payload-exact), so ps[] stores are bit-identical to the old i64
    // path for finite values and PRESERVE NaN payloads (the old Phase-3 f32.demote_f64
    // canonicalized them — the conformance gate confirms the corpus is unaffected).
    {
        auto rt_s = frc.BindSingleWrite(rt);
        wb.op_local_get(LOCAL_PSQ_T0);
        wb.op_f32_reinterpret_i32();
        wb.op_f32x4_splat();                 // v128 [ps0,ps0,ps0,ps0]
        wb.op_local_get(LOCAL_PSQ_T1);
        wb.op_f32_reinterpret_i32();
        wb.op_f32x4_replace_lane(1);         // v128 [ps0,ps1,ps0,ps0]
        wb.op_local_set(rt_s.v128_idx);
    }

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// [psq_st raw-f32 2026-07-14] FTZ a raw f32 (bits in `bits_local`, i32) to the stored single bits.
// When rs is Single-repr, its v128 lane IS the single value, and ConvertToSingleFTZ(promote(f32))
// reduces to a pure f32-domain flush: subnormal (exp field == 0 AND mantissa != 0) -> signed zero,
// else keep the f32 bits. This replaces the Bind-promote (~27 ops) + emit_convert_to_single_ftz
// (~35 ops, reads the i64/f64 form) with ~11 ops on the already-single f32. Pushes the i32 result.
static void emit_ftz_f32_bits(WasmModuleBuilder& wb, u32 bits_local) {
    wb.op_local_get(bits_local);                         // keep-value (not subnormal)
    wb.op_local_get(bits_local);
    wb.op_i32_const((s32)0x80000000u);
    wb.op_i32_and();                                     // flush-value (sign only)
    // cond nonzero => pick keep-value: keep = (exp field != 0) | (mantissa == 0)
    wb.op_local_get(bits_local);
    wb.op_i32_const(0x7F800000);
    wb.op_i32_and();                                     // exp field (nonzero if exp!=0)
    wb.op_local_get(bits_local);
    wb.op_i32_const(0x007FFFFF);
    wb.op_i32_and();
    wb.op_i32_eqz();                                     // mantissa == 0
    wb.op_i32_or();                                      // (exp!=0) | (mant==0) = keep
    wb.op_select();
}

void emit_psq_st(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rs = GekkoOperands::RD(inst);  // FS field, same bit position
    const u32 ra = GekkoOperands::RA(inst);
    const u32 W  = (inst >> 15) & 1u;
    const u32 I  = (inst >> 12) & 7u;
    const u32 simm12 = (u32)(((s32)(inst << 20)) >> 20);

    emit_ea_d_form(wb, rc, ra, simm12);
    // [psq_st raw-f32 2026-07-14] If rs is Single-repr, bind it as the v128 (BindSingleRead) and
    // read the store value straight from the f32 lanes — skip the Bind promote to Double + the
    // f64->single ConvertToSingleFTZ round-trip. NO frc.Flush (same as emit_store_common's
    // flush-narrow: the host WRITE handler reads gpr[] never ps[], and a frc.Flush here would
    // promote a still-Single rs back to Double, defeating this). rc.Flush (GPRs) stays.
    const bool rs_single = frc.IsSingle(rs);
    RCFprPair rs_pair{};
    u32 rs_v128 = 0;
    if (rs_single)
        rs_v128 = frc.BindSingleRead(rs).v128_idx;
    else
        rs_pair = frc.Bind(rs, FPRMode::Read, W ? FPR_LANE_PS0 : FPR_LANE_BOTH);
    rc.Flush(params.ctx_ptr);

    // Push the FTZ'd single store-bits (i32) for lane `lane` (rs_pair.psN_idx is the Double-form
    // i64 local, used only in the !rs_single path).
    auto emit_store_bits = [&](u32 ps_i64_local, u32 lane) {
        if (rs_single) {
            wb.op_local_get(rs_v128);
            wb.op_f32x4_extract_lane((u8)lane);
            wb.op_i32_reinterpret_f32();
            wb.op_local_set(LOCAL_PSQ_T0);              // i32 scratch (free in the FLOAT arm)
            emit_ftz_f32_bits(wb, LOCAL_PSQ_T0);
        } else {
            emit_convert_to_single_ftz(wb, ps_i64_local);
        }
    };
    // Push the lane's f32 value (for the quantized scale/clamp math).
    auto emit_lane_f32 = [&](u32 ps_i64_local, u32 lane) {
        if (rs_single) {
            wb.op_local_get(rs_v128);
            wb.op_f32x4_extract_lane((u8)lane);
        } else {
            wb.op_local_get(ps_i64_local);
            wb.op_f64_reinterpret_i64();
            wb.op_f32_demote_f64();
        }
    };

    // [psq-gqr-spec PM48 2026-08-03] GQR-CONSTANT specialization: read the LIVE
    // GQR at EMIT time (host-side — compilation runs on the EmuThread, same as
    // the spec-mask read) and, for the quantized store types, emit a guarded
    // arm with the type/scale/clamp resolved at COMPILE time: the runtime
    // factor lookup (emit_psq_factor_from_scale) becomes one f32 constant and
    // the sign/width clamp tree disappears. Guard = full 32-bit GQR equality;
    // mismatch falls to the byte-identical generic body (mtspr-to-GQR is an
    // interp fallback that evicts nothing — the guard, not eviction, keeps
    // this sound). The MP4 THP pixel stores (GQR6=0x3d043d04, U8 scale-8) are
    // the measured target — 8 stores per IDCT iteration.
    bool gqr_specialized = false;
    if (g_bem_lc_base) {
        const u32 gqr_live = *reinterpret_cast<volatile u32*>(
            static_cast<uintptr_t>(params.ctx_ptr + ppc_off::spr(912u + I)));
        const u32 st_type = gqr_live & 7u;
        if (st_type >= 4u) {   // 4=U8 5=U16 6=S8 7=S16 (quantized int stores)
            gqr_specialized = true;
            const u32 scale6 = (gqr_live >> 8) & 0x3Fu;
            // bit-exact mirror of emit_psq_factor_from_scale(quantize=true):
            // exp = 127 + sext6(scale) ; factor bits = exp << 23.
            const s32 sext = (s32)(scale6 << 26) >> 26;
            const u32 factor_bits = (u32)((127 + sext) << 23);
            const bool is_signed = (st_type & 2u) != 0u;
            const bool is_16bit  = (st_type & 1u) != 0u;
            const double clamp_lo = is_signed ? (is_16bit ? -32768.0 : -128.0) : 0.0;
            const double clamp_hi = is_signed ? (is_16bit ? 32767.0 : 127.0)
                                              : (is_16bit ? 65535.0 : 255.0);
            wb.op_i32_const((s32)params.ctx_ptr);
            wb.op_i32_load(ppc_off::spr(912u + I));
            wb.op_i32_const((s32)gqr_live);
            wb.op_i32_eq();
            wb.op_if(BLOCK_TYPE_VOID);
            {
                const u32 srcs[2] = { rs_pair.ps0_idx, rs_pair.ps1_idx };
                const u32 outs[2] = { LOCAL_PSQ_T0, LOCAL_PSQ_T1 };
                const u32 nlanes = W ? 1u : 2u;
                for (u32 ln = 0; ln < nlanes; ++ln) {
                    emit_lane_f32(srcs[ln], ln);
                    wb.op_i32_const((s32)factor_bits);
                    wb.op_f32_reinterpret_i32();        // constant 2^scale factor
                    wb.op_f32_mul();
                    wb.op_f64_promote_f32();
                    wb.op_local_set(LOCAL_PSQ_F64);
                    emit_psq_clamp_f64(wb, clamp_lo, clamp_hi);
                    wb.op_local_get(LOCAL_PSQ_F64);
                    wb.op_i32_trunc_sat_f64_s();
                    wb.op_local_set(outs[ln]);
                }
                // pack + store — exact mirror of the generic arms, type known.
                if (is_16bit) {
                    if (W) {
                        emit_fastmem_guard(wb, params, 2);
                        wb.op_if(BLOCK_TYPE_VOID);
                            emit_fastmem_store(wb, params, StoreWidth::U16, LOCAL_PSQ_T0);
                        wb.op_else();
                            emit_slowmem_store(wb, params, StoreWidth::U16, LOCAL_PSQ_T0);
                        wb.op_end();
                    } else {
                        wb.op_local_get(LOCAL_PSQ_T0);
                        wb.op_i32_const(16);
                        wb.op_i32_shl();
                        wb.op_local_get(LOCAL_PSQ_T1);
                        wb.op_i32_const(0xFFFF);
                        wb.op_i32_and();
                        wb.op_i32_or();
                        wb.op_local_set(LOCAL_PSQ_T0);
                        emit_fastmem_guard(wb, params, 4);
                        wb.op_if(BLOCK_TYPE_VOID);
                            emit_fastmem_store(wb, params, StoreWidth::U32, LOCAL_PSQ_T0);
                        wb.op_else();
                            emit_slowmem_store(wb, params, StoreWidth::U32, LOCAL_PSQ_T0);
                        wb.op_end();
                    }
                } else {
                    if (W) {
                        emit_fastmem_guard(wb, params, 1);
                        wb.op_if(BLOCK_TYPE_VOID);
                            emit_fastmem_store(wb, params, StoreWidth::U8, LOCAL_PSQ_T0);
                        wb.op_else();
                            emit_slowmem_store(wb, params, StoreWidth::U8, LOCAL_PSQ_T0);
                        wb.op_end();
                    } else {
                        wb.op_local_get(LOCAL_PSQ_T0);
                        wb.op_i32_const(0xFF);
                        wb.op_i32_and();
                        wb.op_i32_const(8);
                        wb.op_i32_shl();
                        wb.op_local_get(LOCAL_PSQ_T1);
                        wb.op_i32_const(0xFF);
                        wb.op_i32_and();
                        wb.op_i32_or();
                        wb.op_local_set(LOCAL_PSQ_T0);
                        emit_fastmem_guard(wb, params, 2);
                        wb.op_if(BLOCK_TYPE_VOID);
                            emit_fastmem_store(wb, params, StoreWidth::U16, LOCAL_PSQ_T0);
                        wb.op_else();
                            emit_slowmem_store(wb, params, StoreWidth::U16, LOCAL_PSQ_T0);
                        wb.op_end();
                    }
                }
            }
            wb.op_else();   // GQR changed since compile — generic body below
        }
    }

    // gqr -> LOCAL_TMP_VAL (st_type bits 0-2, st_scale 8-13)
    wb.op_i32_const((s32)params.ctx_ptr);
    wb.op_i32_load(ppc_off::spr(912u + I));
    wb.op_local_set(LOCAL_TMP_VAL);

    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(7);
    wb.op_i32_and();
    wb.op_i32_eqz();
    wb.op_if(BLOCK_TYPE_VOID);
    {
        // FLOAT: ConvertToSingleFTZ per lane, no scale (ILSP:156-168).
        // [perf] fastmem-guarded — RAM f32 stores skip the dolphin_write32
        // crossing. WGPIPE (0xCC008000) + MMIO are rejected by the region
        // classifier -> slow import arm, so gp_dirty_check / FIFO ordering is
        // preserved for direct GX vertex submission. The fast arm parks the
        // host base in LOCAL_PSQ_T1 and bswap+i32.store's at +0/+4.
        // [gp-inwasm FP-words 2026-08-29] the slow arm now tries the WPAR
        // in-wasm append first — see emit_fp_words_gp_or_import. This was the
        // one store class the [gp-inwasm] arm never covered, because this
        // branch hand-rolls its WIMPORT_WRITE32s instead of calling
        // emit_slowmem_store. Scratch = LOCAL_PSQ_T1 (dead on this arm; it is
        // the FASTMEM arm's host-base slot, and the two arms are exclusive).
        if (W) {
            emit_fastmem_guard(wb, params, 4);
            wb.op_if(BLOCK_TYPE_VOID);
                wb.op_local_get(LOCAL_TMP_EA);
                wb.op_i32_const((s32)params.mem1_mask);
                wb.op_i32_and();
                wb.op_i32_const((s32)params.mem1_base);
                wb.op_i32_add();
                emit_store_bits(rs_pair.ps0_idx, 0);
                emit_bswap_i32(wb);
                wb.op_i32_store(0);
            wb.op_else();
                emit_fp_words_gp_or_import(
                    wb, params, /*nwords=*/1u, /*scratch_local=*/LOCAL_PSQ_T1,
                    [&](u32) { emit_store_bits(rs_pair.ps0_idx, 0); });
            wb.op_end();
        } else {
            emit_fastmem_guard(wb, params, 8);
            wb.op_if(BLOCK_TYPE_VOID);
                wb.op_local_get(LOCAL_TMP_EA);
                wb.op_i32_const((s32)params.mem1_mask);
                wb.op_i32_and();
                wb.op_i32_const((s32)params.mem1_base);
                wb.op_i32_add();
                wb.op_local_set(LOCAL_PSQ_T1);          // host base addr
                wb.op_local_get(LOCAL_PSQ_T1);
                emit_store_bits(rs_pair.ps0_idx, 0);
                emit_bswap_i32(wb);
                wb.op_i32_store(0);
                wb.op_local_get(LOCAL_PSQ_T1);
                emit_store_bits(rs_pair.ps1_idx, 1);
                emit_bswap_i32(wb);
                wb.op_i32_store(4);
            wb.op_else();
                emit_fp_words_gp_or_import(
                    wb, params, /*nwords=*/2u, /*scratch_local=*/LOCAL_PSQ_T1,
                    [&](u32 lane) {
                        emit_store_bits(lane == 0u ? rs_pair.ps0_idx : rs_pair.ps1_idx,
                                        lane);
                    });
            wb.op_end();
        }
    }
    wb.op_else();
    {
        wb.op_local_get(LOCAL_TMP_VAL);
        wb.op_i32_const(4);
        wb.op_i32_and();
        wb.op_if(BLOCK_TYPE_VOID);
        {
            // ScaleAndClamp per lane (ILSP:60-68): conv = f32(ps) * 2^scale
            // (f32 domain), clamp to type bounds, C-cast truncation.
            const u32 srcs[2] = { rs_pair.ps0_idx, rs_pair.ps1_idx };
            const u32 outs[2] = { LOCAL_PSQ_T0, LOCAL_PSQ_T1 };
            const u32 nlanes = W ? 1u : 2u;
            for (u32 ln = 0; ln < nlanes; ++ln) {
                emit_lane_f32(srcs[ln], ln);            // [psq_st raw-f32] f32 lane (Single) or f64->f32 demote (Double)
                wb.op_local_get(LOCAL_TMP_VAL);
                wb.op_i32_const(8);
                wb.op_i32_shr_u();
                wb.op_i32_const(0x3F);
                wb.op_i32_and();
                emit_psq_factor_from_scale(wb, /*quantize=*/true);
                wb.op_f32_mul();
                wb.op_f64_promote_f32();
                wb.op_local_set(LOCAL_PSQ_F64);
                // clamp bounds by type at runtime: sign = bit1, width = bit0
                wb.op_local_get(LOCAL_TMP_VAL);
                wb.op_i32_const(2);
                wb.op_i32_and();
                wb.op_if(BLOCK_TYPE_VOID);
                {
                    wb.op_local_get(LOCAL_TMP_VAL);
                    wb.op_i32_const(1);
                    wb.op_i32_and();
                    wb.op_if(BLOCK_TYPE_VOID);
                    emit_psq_clamp_f64(wb, -32768.0, 32767.0);
                    wb.op_else();
                    emit_psq_clamp_f64(wb, -128.0, 127.0);
                    wb.op_end();
                }
                wb.op_else();
                {
                    wb.op_local_get(LOCAL_TMP_VAL);
                    wb.op_i32_const(1);
                    wb.op_i32_and();
                    wb.op_if(BLOCK_TYPE_VOID);
                    emit_psq_clamp_f64(wb, 0.0, 65535.0);
                    wb.op_else();
                    emit_psq_clamp_f64(wb, 0.0, 255.0);
                    wb.op_end();
                }
                wb.op_end();
                wb.op_local_get(LOCAL_PSQ_F64);
                wb.op_i32_trunc_sat_f64_s();
                wb.op_local_set(outs[ln]);
            }
            // pack + write (WritePair: ps0 in the high element)
            // [psq-quant-fastmem 2026-07-23] Pack into LOCAL_PSQ_T0, then a guarded
            // raw-store arm mirrors the FLOAT path — the quantized arms previously
            // called the import UNCONDITIONALLY per store. WGPIPE (0xCC008000) +
            // MMIO + locked-L1 0xE0 reject to the import, preserving gp_dirty_check
            // and FIFO ordering for GX submission. GQR is no longer needed past
            // this point, so emit_fastmem_store's LOCAL_TMP_VAL bswap scratch is safe.
            wb.op_local_get(LOCAL_TMP_VAL);
            wb.op_i32_const(1);
            wb.op_i32_and();
            wb.op_if(BLOCK_TYPE_VOID);
            {   // 16-bit elements
                if (W) {
                    emit_fastmem_guard(wb, params, 2);
                    wb.op_if(BLOCK_TYPE_VOID);
                        emit_fastmem_store(wb, params, StoreWidth::U16, LOCAL_PSQ_T0);
                    wb.op_else();
                        emit_slowmem_store(wb, params, StoreWidth::U16, LOCAL_PSQ_T0);
                    wb.op_end();
                } else {
                    wb.op_local_get(LOCAL_PSQ_T0);
                    wb.op_i32_const(16);
                    wb.op_i32_shl();
                    wb.op_local_get(LOCAL_PSQ_T1);
                    wb.op_i32_const(0xFFFF);
                    wb.op_i32_and();
                    wb.op_i32_or();
                    wb.op_local_set(LOCAL_PSQ_T0);      // packed word
                    emit_fastmem_guard(wb, params, 4);
                    wb.op_if(BLOCK_TYPE_VOID);
                        emit_fastmem_store(wb, params, StoreWidth::U32, LOCAL_PSQ_T0);
                    wb.op_else();
                        emit_slowmem_store(wb, params, StoreWidth::U32, LOCAL_PSQ_T0);
                    wb.op_end();
                }
            }
            wb.op_else();
            {   // 8-bit elements
                if (W) {
                    emit_fastmem_guard(wb, params, 1);
                    wb.op_if(BLOCK_TYPE_VOID);
                        emit_fastmem_store(wb, params, StoreWidth::U8, LOCAL_PSQ_T0);
                    wb.op_else();
                        emit_slowmem_store(wb, params, StoreWidth::U8, LOCAL_PSQ_T0);
                    wb.op_end();
                } else {
                    wb.op_local_get(LOCAL_PSQ_T0);
                    wb.op_i32_const(0xFF);
                    wb.op_i32_and();
                    wb.op_i32_const(8);
                    wb.op_i32_shl();
                    wb.op_local_get(LOCAL_PSQ_T1);
                    wb.op_i32_const(0xFF);
                    wb.op_i32_and();
                    wb.op_i32_or();
                    wb.op_local_set(LOCAL_PSQ_T0);      // packed halfword
                    emit_fastmem_guard(wb, params, 2);
                    wb.op_if(BLOCK_TYPE_VOID);
                        emit_fastmem_store(wb, params, StoreWidth::U16, LOCAL_PSQ_T0);
                    wb.op_else();
                        emit_slowmem_store(wb, params, StoreWidth::U16, LOCAL_PSQ_T0);
                    wb.op_end();
                }
            }
            wb.op_end();
        }
        wb.op_else();
        {
            // INVALID1/2/3: assert-only in the interpreter; NO write (ILSP:191-195)
        }
        wb.op_end();
    }
    wb.op_end();

    // [psq-gqr-spec PM48] close the specialization guard around the generic body.
    if (gqr_specialized)
        wb.op_end();

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// lfs  FRD, d(rA) — load f32 at EA into BOTH lanes as SINGLE repr (v128
// splat; see emit_fastmem_lfs_body_single). Mirrors emit_lfsx.
void emit_lfs(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
              LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    emit_ea_d_form(wb, rc, ra, simm);
    // [lfs-single PM25] rc.Flush only — see emit_lfsx.
    rc.Flush(params.ctx_ptr);

    emit_fastmem_lfs_body_single(wb, params, frc, rt);

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// lmw rD, d(rA) — load (32 - rD) words sequentially. Per Jit64
// Jit_LoadStore.cpp:644-667. Direct PowerPCState writes + ReloadAll to
// keep the regcache coherent with the loaded slots (avoids the 2026-05-31
// OSCacheInit r28-r31 class regression — see ppc_emit.cpp:54-58).
void emit_lmw(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
              LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rd   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);

    if (ra == 0) {
        wb.op_i32_const((s32)simm);
    } else {
        wb.op_i32_const((s32)params.ctx_ptr);
        wb.op_i32_load(ppc_off::gpr(ra));
        wb.op_i32_const((s32)simm);
        wb.op_i32_add();
    }
    wb.op_local_set(LOCAL_TMP_EA);

    for (u32 i = rd; i <= 31; ++i) {
        wb.op_i32_const((s32)params.ctx_ptr);
        wb.op_local_get(LOCAL_TMP_EA);
        if (i != rd) {
            wb.op_i32_const((s32)((i - rd) * 4u));
            wb.op_i32_add();
        }
        wb.op_call(WIMPORT_READ32);
        wb.op_i32_store(ppc_off::gpr(i));
    }

    rc.ReloadAll(params.ctx_ptr);
    frc.ReloadAll(params.ctx_ptr, /*host_may_write_fprs=*/false);  // lmw: GPRs only
}

// stmw rS, d(rA) — store (32 - rS) words sequentially. Per Jit64
// Jit_LoadStore.cpp:669-697. No ReloadAll needed since stmw doesn't write
// gpr[]; cache stays coherent.
void emit_stmw(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);

    if (ra == 0) {
        wb.op_i32_const((s32)simm);
    } else {
        wb.op_i32_const((s32)params.ctx_ptr);
        wb.op_i32_load(ppc_off::gpr(ra));
        wb.op_i32_const((s32)simm);
        wb.op_i32_add();
    }
    wb.op_local_set(LOCAL_TMP_EA);

    for (u32 i = rs; i <= 31; ++i) {
        wb.op_local_get(LOCAL_TMP_EA);
        if (i != rs) {
            wb.op_i32_const((s32)((i - rs) * 4u));
            wb.op_i32_add();
        }
        wb.op_i32_const((s32)params.ctx_ptr);
        wb.op_i32_load(ppc_off::gpr(i));
        wb.op_call(WIMPORT_WRITE32);
    }
}

// stfiwx fS, rA, rB — write low 32 bits of ps0(rs) f64 as a word.
// Cache-local form: read the i64 from rs's ps0 lane, wrap to i32 low bits,
// write via WIMPORT_WRITE32. Eliminates the latent stale-memory read bug
// (when rs's ps0 lane is cached dirty, the prior i32_load of ps0(rs)
// returned the pre-write value).
void emit_stfiwx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    emit_ea_x_stack(wb, rc, ra, rb);
    wb.op_local_set(LOCAL_TMP_EA);

    auto rs_pair = frc.Bind(rs, FPRMode::Read, FPR_LANE_PS0);
    rc.Flush(params.ctx_ptr);

    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_local_get(rs_pair.ps0_idx);
    wb.op_i32_wrap_i64();
    wb.op_call(WIMPORT_WRITE32);
}

}  // namespace bemental::powerpc
