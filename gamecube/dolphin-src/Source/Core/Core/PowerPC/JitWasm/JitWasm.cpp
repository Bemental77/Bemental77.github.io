// Copyright 2026 Dolphin Emulator Project (bementalCompiler integration)
// SPDX-License-Identifier: GPL-2.0-or-later
//
// JitWasm — bementalCompiler-driven Gekko→WASM JIT for browser builds.
//
// Wiring stage 2 (2026-05-30): Run() drives bemental::BlockCache directly.
// Per-block compile-on-miss with CachedInterpreter::Run fallback when the
// compile fails (unsupported instruction stream, decode error, or the wasm
// runtime rejects the produced module). The merged-region path
// (region_accumulate / region_relink / region_dispatch) is not yet wired
// here — it requires region-partition decisions + the lookup_fn that
// resolves cross-block branches to local fn indices. Per-block-only is
// correctness-clean and lets us reach the first runtime trajectory.
//
// What this file deliberately does NOT contain (per the post-2026-05-29
// "remove dolphin-src and re-apply only the JIT swap" sanitization):
//   - Per-PC equality skip workarounds (e.g. [zz5294-skip]). Bugs in the
//     emitter must be fixed in bementalJIT/, not papered over here.
//   - EM_ASM diagnostic blocks or [r31-sentinel]/[oslc-bypass]/[wtraj]
//     instrumentation. Probe-side instrumentation lives in the link
//     script / probe driver, not in the JIT.
//   - HLE replace tables. HLE is upstream Dolphin's HLE.cpp — separate
//     concern, separate patch (currently OUT of scope).

#ifdef __EMSCRIPTEN__

#include "Core/PowerPC/JitWasm/JitWasm.h"

#include <emscripten.h>  // [WGPU-PROF — TEMP] emscripten_get_now for the Advance() frame timer

// [fprf-gate PM46] Config::MAIN_FPRF for the native-exact FPRF emission gate.
#include "Common/Config/Config.h"
#include "Core/Config/MainSettings.h"

#include <climits>
#include <cstdint>
#include <cstdlib>  // [WS-1 STEP-3] getenv/atoi for BEM_FP_RESIDENT_LOOP toggle
#include <cstring>  // [AOT A1] std::memcmp for the asset magic
#include <unordered_map>  // [AOT A1] the prebuilt-block registry
#include <vector>

#include <emscripten.h>
#include <emscripten/threading.h>

#include "Common/CommonTypes.h"
#include "Core/CoreTiming.h"
#include "Core/DSPEmulator.h"
#include "Core/HLE/HLE.h"
#include "Core/HW/CPU.h"
#include "Core/HW/DSP.h"
#include "Core/HW/Memmap.h"
#include "Core/PowerPC/JitInterface.h"
#include "Core/PowerPC/MMU.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"
#include "VideoCommon/Fifo.h"  // [dc 2026-07-21] DrainFifoOnCpuThread — CPU-side GX FIFO decode

#include "bementalJIT/types.h"
#include "ppc_analyst.h"  // bemental::powerpc::IsBlockTerminator — single source of truth.

namespace WGPU { extern double g_prof_advance_ms; }  // [WGPU-PROF — TEMP] defined in WGPUGfx.cpp
#include "ppc_emit.h"     // bementalJIT/guests/powerpc-next/ppc_emit.h (PUBLIC include dir)

// Compiler-verified anchors for the hand-maintained wasm32 offsets in
// bementalJIT ppc_offsets.h (EXCEPTIONS / DOWNCOUNT). The emitted blocks'
// in-block downcount accounting and the chain dispatcher's bail reads
// depend on these exact offsets.
static_assert(offsetof(PowerPC::PowerPCState, Exceptions) == 0x2EC,
              "ppc_off::EXCEPTIONS out of sync with PowerPCState layout");
static_assert(offsetof(PowerPC::PowerPCState, downcount) == 0x2F0,
              "ppc_off::DOWNCOUNT out of sync with PowerPCState layout");

// [dual-core diag] sticky handover flag (ProcessorInterface.cpp) — gates [chain0] post-handover.
extern "C" int g_dc_handover_done;
// [lc-window PM23] defined in bementalJIT block_cache.cpp; consumed by the
// powerpc-next emitters' LC slow-arm shortcut.
extern "C" uint32_t g_bem_lc_base;
// [fprf-gate PM46] bFPRF half of the FPRF emission gate (block_cache.cpp).
extern "C" uint32_t g_bem_fprf_enabled;
// [accurate-nans-gate PM59] m_accurate_nans half (block_cache.cpp).
extern "C" uint32_t g_bem_accurate_nans;
// [WS-1 STEP-3] fp_resident_loop region A/B + kill switch (block_cache.cpp).
extern "C" uint32_t g_bem_fp_resident_loop;
// [single-spec PM26] sticky force-double registry (block_cache.cpp).
extern "C" void bem_pc_force_double_add(uint32_t pc);

namespace
{
// Block-decode limit. Matches the conservative cap the legacy build_block
// path used. Branches always terminate; this is the upper bound for
// fall-through fetch.
// [block-cap PM52 2026-08-03 — TRIED 160, WASH, REVERTED] The chain census
// (4.8M tail-calls/s, 99.66% hit-rate) put the cross-module
// return_call_indirect tax at ~12.9%; raising the cap to 160 left chainTaken
// UNCHANGED (370.9M vs 362.5M/75s) — the hot working set is
// TERMINATOR-bounded (branches every <64 instrs), not cap-bounded, and
// bigger blocks worsen the cold-compile transient. The boundary killer for
// branchy code is BRANCH-FOLLOWING / region merging (analyst flag
// m_enable_branch_following exists, defaults false — PM39's #1 structural
// item), not a larger straight-line cap.
constexpr u32 kMaxBlockInsts = 64;

// IsBlockTerminator — forwards to bemental::powerpc::IsBlockTerminator
// (ppc_analyst.h / ppc_analyst.cpp). One source of truth keyed off the
// FL_ENDBLOCK flag in ppc_tables.cpp, shared with PPCAnalyzer::Analyze's
// per-op canEndBlock derivation. Adding/removing FL_ENDBLOCK on a table
// entry updates BOTH decoder paths in one move — no drift.
//
// Prior to consolidation (2026-06-07) this was a JitWasm.cpp-local
// hardcoded list (primary 16/17/18 + 19 sub-opcodes 16/50/528), which was
// a strict subset of the canonical FL_ENDBLOCK set and silently missed any
// new FL_ENDBLOCK-flagged op (twi, tw, mtsr, mtsrin, mtmsr, tlbie, icbi,
// etc.). The table-driven path matches Dolphin Jit64's
// InstructionCanEndBlock (PPCAnalyst.cpp:218-223 upstream), minus the
// mtspr/MMCR0/MMCR1 special-case (bementalJIT's mtspr table entry lacks
// FL_ENDBLOCK, so the filter is moot here).
inline bool IsBlockTerminator(u32 inst)
{
  return bemental::powerpc::IsBlockTerminator(inst);
}

// ---------------------------------------------------------------------------
// [AOT A1] Ahead-of-time block registry.
//
// Blocks are emitted OFFLINE by the native aot_compile tool
// (gamecube/bementalJIT/tools/aot_compile.cpp) into a psmtxro.bjaot asset,
// streamed in at boot by the worker glue (worker_funcs.js onRuntimeInitialized),
// and handed to bem_aot_load. In TryCompileBlock a matching PC swaps the
// prebuilt bytes for build_block_next's output — the point of AOT. A1 proves
// the PIPELINE (async load -> integrity re-emit -> ctx-match -> swap ->
// counters -> kill-switch), not fps; PSMTXROMultVecArray is ~1.6% of samples.
//
// PROXY_TO_PTHREAD constraint (see the onRuntimeInitialized note ~L94): wasm
// file-statics are PER-INSTANCE. The JS fetch runs on the worker-main instance
// but TryCompileBlock runs on the EmuThread pthread instance. So JS only
// mallocs the bytes into SHARED linear memory and publishes (ptr,len) via SAB
// cells; bem_aot_load is invoked FROM Run() (the pthread) so g_aot_blocks lives
// on the instance that reads it. Same handshake shape as s_bridge_published.
//
// SAB cells (reserved 0x026B34xx, verified free 2026-08-12):
//   0x026B3468  u32  asset ptr in shared heap (JS sets LAST = the trigger)
//   0x026B346C  u32  asset byte length      (JS sets FIRST)
//   0x026B3470  u32  blocks parsed from the asset (bem_aot_load)
//   0x026B3474  u32  KILL switch: 0 = AOT active (default), nonzero = forced off
//   0x026B3478  u32  swaps performed (AOT bytes registered instead of JIT)
//   0x026B347C  u32  integrity mismatches (re-emit != asset -> safe fallback)
//   0x026B3480  u32  ctx mismatches (asset baked_ctx != live &ppc_state)
//   0x026B3484  u32  last live ctx_ptr at a matching compile (bake target)
//   0x026B3488  u32  asset baked_ctx echo
//   0x026B348C  u32  load status: 1 ok, 0x8000000x = parse error code
struct AotEntry { std::vector<u8> wasm; std::vector<u32> gwords; u32 gspan = 0; u32 ghash = 0; u32 cycles = 0; };
std::unordered_map<u32, AotEntry> g_aot_blocks;
u32  g_aot_baked_ctx = 0;
bool g_aot_loaded    = false;

inline volatile u32* AotCell(u32 addr)
{
  return reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(addr));
}
inline u32 AotRd32LE(const u8* p)
{
  return static_cast<u32>(p[0]) | (static_cast<u32>(p[1]) << 8) |
         (static_cast<u32>(p[2]) << 16) | (static_cast<u32>(p[3]) << 24);
}
inline void AotBump(u32 addr)  // volatile RMW without the C++20 ++volatile deprecation
{
  volatile u32* c = AotCell(addr);
  *c = *c + 1u;
}
// FNV-1a over guest instruction words — the registration hash. MUST match the
// offline tool (aot_compile.cpp): the emitter is context-sensitive so we cannot
// bit-compare emitted wasm; instead we verify the GUEST CODE is what we AOT'd.
inline u32 AotGuestHash(const u32* insts, u32 count)
{
  u32 h = 0x811c9dc5u;
  for (u32 i = 0; i < count; ++i)
    for (int k = 0; k < 4; ++k) { h ^= (insts[i] >> (8 * k)) & 0xFFu; h *= 0x01000193u; }
  return h;
}

// Parse a psmtxro.bjaot v2 blob. MUST run on the EmuThread pthread instance.
// Format: "BJAOT\0" | ver=2 u32 | baked_ctx u32 | n u32
//   | n*(pc u32, gspan u32, ghash u32, cycles u32, wasm_len u32)
//   | for each block: gspan guest words (skipped at load — the ghash covers them)
//   | for each block: wasm_len bytes.
void AotLoadFromMemory(const u8* data, u32 len)
{
  g_aot_blocks.clear();
  g_aot_loaded = false;
  *AotCell(0x026B3470u) = 0u;
  if (!data || len < 18u || std::memcmp(data, "BJAOT", 6) != 0)
  {
    *AotCell(0x026B348Cu) = 0x80000001u;
    return;
  }
  u32 off = 6u;
  const u32 ver   = AotRd32LE(data + off); off += 4u;
  g_aot_baked_ctx = AotRd32LE(data + off); off += 4u;
  const u32 n     = AotRd32LE(data + off); off += 4u;
  if (ver != 2u || n == 0u || n > 4096u)
  {
    *AotCell(0x026B348Cu) = 0x80000002u;
    return;
  }
  if (static_cast<u64>(off) + static_cast<u64>(n) * 20ull > len)
  {
    *AotCell(0x026B348Cu) = 0x80000003u;
    return;
  }
  struct Ent { u32 pc, gspan, ghash, cycles, wlen; };
  std::vector<Ent> tbl(n);
  for (u32 i = 0; i < n; ++i)
  {
    tbl[i].pc     = AotRd32LE(data + off); off += 4u;
    tbl[i].gspan  = AotRd32LE(data + off); off += 4u;
    tbl[i].ghash  = AotRd32LE(data + off); off += 4u;
    tbl[i].cycles = AotRd32LE(data + off); off += 4u;
    tbl[i].wlen   = AotRd32LE(data + off); off += 4u;
  }
  // Guest-words region (gspan words per block) — kept for exact-compare
  // authentication (the ghash is a fast pre-filter; the words are the authority).
  std::vector<std::vector<u32>> words(n);
  for (u32 i = 0; i < n; ++i)
  {
    if (static_cast<u64>(off) + static_cast<u64>(tbl[i].gspan) * 4ull > len)
    {
      *AotCell(0x026B348Cu) = 0x80000005u;
      return;
    }
    words[i].resize(tbl[i].gspan);
    for (u32 j = 0; j < tbl[i].gspan; ++j) { words[i][j] = AotRd32LE(data + off); off += 4u; }
  }
  for (u32 i = 0; i < n; ++i)
  {
    if (static_cast<u64>(off) + tbl[i].wlen > len)
    {
      *AotCell(0x026B348Cu) = 0x80000004u;
      return;
    }
    AotEntry e;
    e.wasm.assign(data + off, data + off + tbl[i].wlen);
    e.gwords = std::move(words[i]);
    e.gspan = tbl[i].gspan;
    e.ghash = tbl[i].ghash;
    e.cycles = tbl[i].cycles;
    off += tbl[i].wlen;
    g_aot_blocks[tbl[i].pc] = std::move(e);
  }
  g_aot_loaded = true;
  *AotCell(0x026B3470u) = n;
  *AotCell(0x026B3488u) = g_aot_baked_ctx;
  *AotCell(0x026B348Cu) = 1u;
}

// Called once from Run() (pthread) after JS publishes (ptr,len). One-shot:
// consumes + clears the trigger cell + frees the shared buffer.
void AotPollAndLoad()
{
  if (g_aot_loaded)
    return;
  const u32 ptr = *AotCell(0x026B3468u);   // trigger (JS writes this LAST)
  if (ptr == 0u)
    return;
  const u32 len = *AotCell(0x026B346Cu);
  AotLoadFromMemory(reinterpret_cast<const u8*>(static_cast<uintptr_t>(ptr)), len);
  *AotCell(0x026B3468u) = 0u;               // consume the trigger
  std::free(reinterpret_cast<void*>(static_cast<uintptr_t>(ptr)));
}

// ---------------------------------------------------------------------------
// [AOT A3.1] MERGED whole-function asset (BJAOTM v3) — a pre-built $region module
// (aot_merge.cpp) registered as an IMMUTABLE region gen via aot_seal_merged.
// Separate SAB trigger cell (0x026B3490 ptr / 0x026B3494 len) + telemetry
// 0x026B34A4..34BC. Re-seals after clear() (savestate load wipes all gens).
struct AotMergedBlk { u32 pc, gspan, ghash; };
std::vector<AotMergedBlk> g_aotm_blocks;
std::vector<u8> g_aotm_module;
u32  g_aotm_ctx = 0u, g_aotm_gen = 0u;
bool g_aotm_parsed = false;

void AotParseMerged(const u8* data, u32 len)
{
  g_aotm_blocks.clear(); g_aotm_module.clear(); g_aotm_parsed = false;
  if (!data || len < 23u || std::memcmp(data, "BJAOTM", 7) != 0) { *AotCell(0x026B34A4u) = 0x80000001u; return; }
  u32 off = 7u;
  const u32 ver = AotRd32LE(data + off); off += 4u;
  g_aotm_ctx    = AotRd32LE(data + off); off += 4u;
  g_aotm_gen    = AotRd32LE(data + off); off += 4u;
  const u32 n   = AotRd32LE(data + off); off += 4u;
  if (ver != 3u || n == 0u || n > 4096u) { *AotCell(0x026B34A4u) = 0x80000002u; return; }
  if (static_cast<u64>(off) + static_cast<u64>(n) * 12ull + 4ull > len) { *AotCell(0x026B34A4u) = 0x80000003u; return; }
  g_aotm_blocks.resize(n);
  for (u32 i = 0; i < n; ++i)
  {
    g_aotm_blocks[i].pc    = AotRd32LE(data + off); off += 4u;
    g_aotm_blocks[i].gspan = AotRd32LE(data + off); off += 4u;
    g_aotm_blocks[i].ghash = AotRd32LE(data + off); off += 4u;
  }
  const u32 mlen = AotRd32LE(data + off); off += 4u;
  if (static_cast<u64>(off) + mlen > len) { *AotCell(0x026B34A4u) = 0x80000004u; return; }
  g_aotm_module.assign(data + off, data + off + mlen);
  g_aotm_parsed = true;
  *AotCell(0x026B34A8u) = n;
  *AotCell(0x026B34ACu) = g_aotm_gen;
  *AotCell(0x026B34A4u) = 1u;
}

void AotMergedPoll()
{
  if (g_aotm_parsed) return;
  const u32 ptr = *AotCell(0x026B3490u);    // trigger (JS writes LAST)
  if (ptr == 0u) return;
  const u32 len = *AotCell(0x026B3494u);
  AotParseMerged(reinterpret_cast<const u8*>(static_cast<uintptr_t>(ptr)), len);
  *AotCell(0x026B3490u) = 0u;
  std::free(reinterpret_cast<void*>(static_cast<uintptr_t>(ptr)));
}

// Authenticate every block's LIVE guest code (FNV vs the asset ghash — the game
// binary is byte-identical to the decomp we compiled from), require baked_ctx ==
// live ctx + KILL off, then seal the immutable gen. Re-runs until the guest code
// is loaded (auth passes) and again after clear(). Template avoids naming the
// Dolphin Memory / BlockCache types here.
template <typename Cache, typename Mem>
void AotMergedTrySeal(Cache& cache, Mem& mem, u32 live_ctx)
{
  if (!g_aotm_parsed || cache.aot_is_sealed()) return;
  if (*AotCell(0x026B3474u) != 0u) return;                 // shared KILL switch
  *AotCell(0x026B34B0u) = live_ctx;
  if (g_aotm_ctx != live_ctx) { AotBump(0x026B34B4u); return; }  // ctx mismatch
  std::vector<u32> pcs; pcs.reserve(g_aotm_blocks.size());
  for (const AotMergedBlk& b : g_aotm_blocks)
  {
    u32 h = 0x811c9dc5u;
    for (u32 j = 0; j < b.gspan; ++j)
    {
      const u32 w = mem.Read_U32(b.pc + j * 4u);
      for (int k = 0; k < 4; ++k) { h ^= (w >> (8 * k)) & 0xFFu; h *= 0x01000193u; }
    }
    if (h != b.ghash) { AotBump(0x026B34BCu); return; }     // auth mismatch (code not ready / SMC / wrong game)
    pcs.push_back(b.pc);
  }
  if (cache.aot_seal_merged(g_aotm_module.data(), g_aotm_module.size(),
                            pcs.data(), static_cast<u32>(pcs.size()), g_aotm_gen))
    AotBump(0x026B34B8u);                                   // seals
}
}  // namespace

void JitWasm::Init()
{
  CachedInterpreter::Init();
  // Wire compile-time HLE-hook query into bementalJIT so build_block_next
  // skips per-op rc.Flush + emit_hle_prologue + rc.ReloadAll for un-hooked
  // PCs (overwhelming majority). Per structural audit wp7gh3uoi finding #1:
  // ~18x per-op bookkeeping blowup eliminated. Mirrors Jit64's compile-time
  // HandleFunctionHooking at Jit.cpp:1065.
  bemental::powerpc::g_hle_hook_query = [](u32 pc) -> bool {
    return HLE::GetHookByAddress(pc) != 0;
  };
}

void JitWasm::Shutdown()
{
  m_wasm_cache.clear();
  m_block_inst_counts.clear();
  m_block_guest_end.clear();
  CachedInterpreter::Shutdown();
}

void JitWasm::ClearCache()
{
  // Drop both caches together so a subsequent dispatch re-compiles with
  // current state (HLE patches installed, regcache assumptions reset,
  // etc.). Called from JitInterface::ClearCache via the inherited virtual.
  m_wasm_cache.clear();
  m_block_inst_counts.clear();
  m_block_guest_end.clear();
  CachedInterpreter::ClearCache();
}

void JitWasm::EvictBlock(u32 pc)
{
  m_wasm_cache.evict(pc);
  m_block_inst_counts.erase(pc);
  m_block_guest_end.erase(pc);
}

void JitWasm::InvalidateICacheRange(u32 lo, u32 hi)
{
  // Blocks decode at most 64 instructions (256 guest bytes — see
  // TryCompileBlock), so any block overlapping [lo, hi) starts at or
  // after lo - kMaxBlockInsts*4 (PM52: bound scales with the decode cap).
  constexpr u32 kMaxBlockBytes = kMaxBlockInsts * 4u;
  auto it = m_block_guest_end.lower_bound(lo >= kMaxBlockBytes ? lo - kMaxBlockBytes : 0u);
  while (it != m_block_guest_end.end() && it->first < hi)
  {
    if (it->second > lo)
    {
      m_wasm_cache.evict(it->first);
      m_block_inst_counts.erase(it->first);
      m_block_is_idle.erase(it->first);
      it = m_block_guest_end.erase(it);
    }
    else
    {
      ++it;
    }
  }
}

// C-linkage helper for the bridge (dolphin-bridge can't include JitWasm.h
// because that pulls bementalJIT/block_cache.h via the m_wasm_cache
// member, and the bridge's link-step compile doesn't have the bementalJIT
// include path). Defined here in JitWasm.cpp where the full type is in
// scope. Callable from dolphin-bridge as `extern "C" void
// dolphin_evict_block(uint32_t)`.
// Called from JitInterface::InvalidateICache/InvalidateICacheLine so guest
// icbi (and host icache invalidations) evict our wasm blocks too — the
// inherited JitBaseBlockCache path doesn't know about m_wasm_cache. Same
// access pattern as dolphin_evict_block below.
extern "C" void jitwasm_invalidate_icache_range(u32 address, u32 size)
{
  auto& system = Core::System::GetInstance();
  auto* core = system.GetJitInterface().GetCore();
  if (auto* jw = dynamic_cast<JitWasm*>(core))
    jw->InvalidateICacheRange(address, address + size);
}

extern "C" EMSCRIPTEN_KEEPALIVE void dolphin_evict_block(u32 pc)
{
  auto& system = Core::System::GetInstance();
  auto* core = system.GetJitInterface().GetCore();
  if (auto* jw = dynamic_cast<JitWasm*>(core))
    jw->EvictBlock(pc);
}

void JitWasm::Run()
{
  auto& mem = m_system.GetMemory();
  auto& ppc_state = m_ppc_state;
  auto& core_timing = m_system.GetCoreTiming();
  const CPU::State* state_ptr = m_system.GetCPU().GetStatePtr();

  // bementalJIT compile inputs. ctx_ptr / mem1_base are wasm linear-memory
  // offsets — under wasm32 these are u32-cast host pointers (the wasm
  // module's linear memory IS the host address space for this process).
  const u32 ctx_ptr   = static_cast<u32>(reinterpret_cast<uintptr_t>(&ppc_state));
  const u32 mem1_base = static_cast<u32>(reinterpret_cast<uintptr_t>(mem.GetRAM()));
  const u32 mem1_mask = mem.GetRamMask();
  const u32 ram_size  = mem.GetRamSize();
  // [lc-window PM23] publish the 256KB locked-L1 backing address so the emitter's
  // slow arms serve [0xE0000000, 0xE0040000) with raw in-wasm loads/stores instead
  // of a cross-instance import per access (THP pixel workspace: 222.7M calls/120s).
  g_bem_lc_base = static_cast<u32>(reinterpret_cast<uintptr_t>(mem.GetL1Cache()));
  // [fprf-gate PM46 2026-07-31] native-exact FPRF gating: Jit64 emits FPRF only when
  // `bFPRF && wantsFPRF`; bFPRF defaults false and GMPE01 has no override, so native
  // MP4 emits NO FPRF code. We paid a ~150-op classifier on nearly every ps op
  // (IDCT dump: 223 lines per SIMD arith op). Mirror the config half here.
  g_bem_fprf_enabled = Config::Get(Config::MAIN_FPRF) ? 1u : 0u;
  // [accurate-nans-gate PM59] same native-parity class: Jit64 emits the paired-
  // single NaN ladder only when m_accurate_nans (Config MAIN_ACCURATE_NANS,
  // default false). Mirror it so games get native-default fast FP; the accurate
  // path stays validated by test_diff_next (which forces it on).
  g_bem_accurate_nans = Config::Get(Config::MAIN_ACCURATE_NANS) ? 1u : 0u;
  // [WS-1 STEP-3] The fp_resident_loop runtime toggle does NOT go through here:
  // getenv is dead in the worker (cross-thread Module.ENV never reaches the C
  // environ — week-one dispatch-audit lesson). The kill switch rides a shared SAB
  // cell (0x026B3408) the page writes from ?bjit_fp_resident_loop, read per-emit
  // in ppc_emit.cpp. The global g_bem_fp_resident_loop stays the compile default.

#ifdef __EMSCRIPTEN__
  // [ppc-bridge] Publish the REAL ppc_state + RAM addresses into the SAB for the
  // ppc-worker. dolphin_set_ppc_state_external_storage() is a stub and g_jit_wasm /
  // PowerPCManager are pthread-isolated under PROXY_TO_PTHREAD, so the page's mailbox
  // query sees nullptr. This runs on the pthread where &ppc_state and m_ram are valid.
  // The page's ram-info poll (gamecube.html ~:1018) consumes addr/size + the new
  // ctx_ptr slot and inits the ppc-worker with the REAL &ppc_state (not the reserved
  // 0x02400000 the stubbed redirect never populated). Sentinel written LAST so the
  // poll only fires once all fields are valid.
  {
    static bool s_bridge_published = false;
    if (!s_bridge_published && mem1_base != 0u && ram_size != 0u && ctx_ptr != 0u)
    {
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x02500020u)) = mem1_base;
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x02500024u)) = ram_size;
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x0250002Cu)) = ctx_ptr;
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x02500028u)) = 0xCAFEBABEu;
      s_bridge_published = true;
    }
  }
  // [AOT A1] one-shot: pick up the psmtxro.bjaot bytes JS fetched + published
  // into shared memory, and parse them ON THIS pthread instance (see the
  // AotEntry registry note — file-statics are per-instance under PROXY_TO_PTHREAD).
  AotPollAndLoad();
  AotMergedPoll();
  // [AOT A3.1] re-seal cadence: cheap aot_is_sealed() check every entry; the
  // auth+seal (bounded guest-code reads) fires only until the gen is live and
  // again after a clear() (savestate load). Low cadence bounds the auth cost.
  {
    static u32 s_aotm_tick = 0u;
    if (!m_wasm_cache.aot_is_sealed() && (s_aotm_tick++ & 0xFFu) == 0u)
      AotMergedTrySeal(m_wasm_cache, mem, ctx_ptr);
  }
#endif

  // Mirror canonical CachedInterpreter::Run: outer loop on CPU::State,
  // CoreTiming::Advance starts each slice (refills downcount + advances
  // scheduled events), inner loop dispatches blocks until downcount expires.
  // The single-loop variant was wrong — under libretro single-core,
  // RunSingleFrame calls power_pc.RunLoop() once per retro_run, and nothing
  // outside our loop advances CoreTiming. With downcount == 0 on entry the
  // body was skipped and retro_run returned ~147k times/sec with zero PPC
  // dispatches (probe_fix.js, 2026-05-30).
  while (*state_ptr == CPU::State::Running)
  {
    // [dc-diag 2026-07-21 TEMP] dolphin EmuThread JitWasm::Run active — proves dolphin (not the
    // ppc-worker) executes the guest CPU.
    { volatile u32* p = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1B58u)); *p = *p + 1u; }
    // [ee-race fix 2026-07-02] NOTE: Advance must keep RUNNING under worker
    // ownership (hybrid VI/DSP/AI events fire ONLY via dolphin's local Advance —
    // CT_PHASE3_ENABLE is not set in the live tree, so the worker's
    // ct_fire_due_pure ignores hybrids). The single-owner-delivery gate lives
    // inside Advance's CheckExternalExceptions call (CoreTiming.cpp): events
    // fire (pending bits set), but vectoring into shared ppc_state is
    // suppressed while the worker owns the CPU.
    // Start new timing slice. Refills downcount; scheduled events fire
    // here (VI, AI, DSP, etc.). NOTE: Advance may set Exceptions / change PC.
    // [WGPU-PROF — gated 2026-07-14] emscripten_get_now runs PER do-loop iter (~400 Advance/frame),
    // and the CPU profile (gc_jit_thread_cpu_profile_2026_07_14) measured get_now at 5.4% of the
    // JIT thread — the hottest removable overhead. Gated behind BEMENTAL_WGPU_PROF (undefined by
    // default = zero cost; rebuild with -DBEMENTAL_WGPU_PROF to restore the advance/jit split).
#ifdef BEMENTAL_WGPU_PROF
    const double t_adv0 = emscripten_get_now();
    core_timing.Advance();
    WGPU::g_prof_advance_ms += emscripten_get_now() - t_adv0;
#else
    core_timing.Advance();
#endif

    // [gpu-drain 2026-07-21] The GX FIFO decode does NOT run here on the EmuThread: RunFifo issues
    // WebGPU device calls (EFB/texture/XFB copies) and this thread does not own the device — it hangs
    // (verified: un-wedged GXDrawDone -> reached Hu3DAnimInit, then froze in an ungated device call).
    // The decode runs on the proxy-main thread that owns the device, pumped from retro_run (Main.cpp).

    // Per-slice idle-skip ring. Must be SLICE-LOCAL (not static), or PCs
    // from a real idle loop in one slice will throttle unrelated blocks
    // in subsequent slices: any block whose next_pc happens to match a
    // stale ring entry incorrectly triggers downcount=0, forcing a one-
    // block-per-slice cadence on unrelated code. Bug found by branch-
    // emit audit 2026-06-07; was previously declared `static` causing
    // process-lifetime contamination of the heuristic.
    u32 last_next[16] = {0};  // [xinst-fix] 16-deep for scheduler-length idle cycles
    u32 ring_streak = 0;
    u32 last_idx = 0;

    do
    {
#ifdef __EMSCRIPTEN__
      // [collapse] AUTHORITATIVE CPU OWNERSHIP. If the WORKER owns the CPU, dolphin dispatches ZERO guest
      // blocks. Checked per do-iteration (the coherent block boundary that already reads Exceptions +
      // supports mid-slice return) — the advisory Phase-IV flag failed because it was re-read only BETWEEN
      // run_iter_batch calls, letting an in-flight retro_run run a whole CoreTiming slice into the shared
      // ppc_state concurrently with the worker. cpu_owner @ SAB 0x026A0000: 0=DOLPHIN (boot default,
      // SAB zero-inits), 1=WORKER. Returning ends this retro_run; run_iter_batch re-evaluates next tick.
      if (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u)
        return;
      // [deterministic-trap 2026-07-06] The page's handover catch was a SAMPLER (freeze +
      // 801 pc reads hoping to coincide with the 4-byte idle spin — the last wall-clock
      // lottery; FAILED runs starved dolphin via endless retries). When the page ARMS
      // (SAB 0x026B0980=1), dolphin parks ITSELF at exactly the idle spin with EE=1 and
      // no pending exceptions (flag=2, event-only busy-wait). The page's existing catch
      // then finds pc==0x800ba2f0 deterministically on its first sample. Unpark on
      // cutover (owner→1), disarm (page abort), or CPU stop.
      {
        volatile u32* const ho_arm =
            reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B0980u));
        // While armed, clamp the slice so region functions exit at near-per-block
        // granularity — the head otherwise only sees pc at region EXITS (hot-region
        // dispatch loops internally), making the spin catch a downcount-exhaustion
        // coincidence again (measured: one run tries=1, next run never). Costs ms,
        // only during the catch window.
        if (*ho_arm == 1u && ppc_state.downcount > 64)
          ppc_state.downcount = 64;
        // Parked (flag==2): stay frozen at the spin but RETURN — a busy-wait here
        // blocked retro_run, killed the dolphin worker's event loop, and the page's
        // cutover protocol (which needs that loop) deadlocked at frame 600. Returning
        // keeps the pump ticking no-ops; guest state stays untouched until the page
        // flips owner or disarms.
        if (*ho_arm == 2u &&
            *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) != 1u)
          return;
        // [one-clock rebase] MOVED to run_iter_batch (EmscriptenWorker.cpp): this
        // placement was unreachable — the owner-check return above fires first post-cutover.
        // Park condition: the idle spin when it exists, OR the OS consistency invariant
        // curCtx(0x800000D4)==curThr(0x800000E4) — post-upload MP4 never enters the idle
        // spin (gate stats: inVIWait=0 across every run's samples), so the pc anchor alone
        // never fires there. The invariant is the same condition the validated 2026-06-29
        // handover gate used: a coherent, non-torn context at a block boundary.
        // [quiescent-boundary park 2026-07-10 — PERMANENT, the one-frame race fix] The arm
        // fires INSIDE SetFinish N, BEFORE N's finish interrupt is raised (PixelEngine.cpp
        // SetFinish: arm at :~289, pending|=true below it). Exceptions==0 passes while the
        // finish event is scheduled-but-unfired, so the park swallowed the in-flight finish:
        // its wake of FinishQueue (DefaultThread's GXWaitDrawDone) never landed -> no frame
        // N+1, ever, at every armframe (months of face-lottery). Gate the park on the
        // OBSERVABLE: finish-inflight @0x026B1A30 == 0 (pending||signal, published by
        // PixelEngine at every transition; cleared only by the guest ISR's ack, and the
        // FinishQueue wake runs in that same EE=0 handler while this park requires EE=1 at
        // the idle spin — so flag==0 here proves raised+delivered+acked+woken). The takeover
        // engages only at a truly quiescent boundary; deferred, never dropped.
        if (*ho_arm == 1u && (ppc_state.msr.Hex & 0x8000u) != 0u && ppc_state.Exceptions == 0 &&
            *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1A30u)) == 0u)
        {
          // [idle-spin-only 2026-07-07] The curCtx==curThr fallback accepted
          // consistent-but-MID-MACHINERY states — every post-takeover wedge face
          // (EE=0 VI polls, 0x900 parked, default-handler orbit, PPCHalt) traced to
          // taking over a guest with interrupt processing in flight. The idle spin is
          // the ONE state the downstream stack is debugged against. The armed downcount
          // clamp above makes the spin catchable at per-block granularity.
          if (ppc_state.pc == 0x800ba2f0u)
          {
            ppc_state.npc = ppc_state.pc;
            *ho_arm = 2u;
            return;
          }
        }
      }
#endif
      // Pending exceptions: let upstream CheckExceptions transition PC to
      // the handler vector; the next iteration dispatches the handler.
      if (ppc_state.Exceptions != 0)
      {
        // [npc-sync — root fix of the deterministic PC=0 ISI] At this dispatch point pc IS the resume
        // instruction; upstream dolphin's do_timing keeps NPC=PC=DISPATCHER_PC so CheckExternalExceptions'
        // SRR0=npc is correct. Our block-dispatch maintains npc only INSIDE region/chain dispatch (below),
        // not at the top of the loop — so a delivery here does SRR0 = a STALE npc (observed npc=0x80010640,
        // an old HuSprDisp epilogue, while pc=0x8000d9f8 in HuSprExec) -> rfi to a dead frame, blr 0.
        // Force npc=pc so the interrupt saves the true interrupted PC.
        ppc_state.npc = ppc_state.pc;
        m_system.GetPowerPC().CheckExceptions();
        if (*state_ptr != CPU::State::Running)
          return;
        // Fall through; pc may now be at a vector (0x400/0x500/etc).
      }

      // HOT-REGION DISPATCH (step 4, 2026-06-17): if the current pc is in the
      // hot merged region, run it in-wasm via the merged br_table function (no
      // per-block JS Map.get + cross-instance run() round-trip) until it
      // branches out of the region OR the slice budget expires. The merged fn
      // charges downcount per internal block and bails at downcount<=0 (R2
      // fix), so we honor the same downcount + exception disciplines as the
      // chain loop. A miss (pc not promoted/hot) returns false -> fall straight
      // through to chain_dispatch below (which advances ppc_state.pc itself).
      // [region-merged 2026-07-15] The region-FIRST dispatch loop that lived
      // here (region_dispatch + its own 16-deep idle-cycle ring) is DELETED:
      // sealed-gen entries now register their fn_k wrappers directly in the
      // GLOBAL dispatch table (block_cache.cpp seal JS), so the normal chain
      // path below enters regions at measured-zero cross-instance cost — no
      // per-hit EM_ASM, no JS-first loop. Its idle protections are replaced by
      // (a) the in-region lap-counter escape emitted by the merged builder
      // (forces downcount=0 at REGION_LAP_MAX warm edges, exc==0-gated) and
      // (b) the chain path's own idle-collapse ring, which region exits reach
      // via the per-edge downcount bail. g_blr_chain's per-entry reset moved
      // into the fn_k wrappers (host-boundary contract, block_cache.cpp:448).
      if (false)
      {
        const u32 region_exc0 = ppc_state.Exceptions;
        // [xinst-fix] Multi-PC idle-skip streak ring — mirrors the chain path's
        // ring (below, ~340-360). Without it, a multi-PC poll cycle (e.g. MP4's
        // VIWaitForRetrace spin at 0x800ba2f0, whose store-bearing outer block is
        // sealed into the region) never returns its own entry pc, so the
        // self-cycle break never fires, the region loop burns the ENTIRE slice,
        // core_timing.Advance() is starved, and the awaited VI/retrace interrupt
        // is never delivered -> permanent spin. This is why promotion regressed
        // games to a stall. Force downcount=0 on an 8-deep <=4-PC cycle so the
        // outer Advance runs and the IRQ fires, identical to the chain path.
        // [xinst-fix] 16-deep ring — the OS thread-scheduler / idle cluster is a
        // ~9-PC cycle (MP4 0x800e56a8..0x800e5794), which a 4-deep ring can NEVER
        // match 8x, so it was never idle-skipped and burned full slices at
        // ~2.5M ticks/s. 16 deep recognizes scheduler-length cycles -> forces an
        // early Advance -> CoreTiming ticks the scheduler timers -> the blocked
        // thread wakes and the guest leaves the cluster.
        u32 r_last[16] = {0};
        u32 r_streak = 0;
        u32 r_idx = 0;
        while (ppc_state.downcount > 0 && ppc_state.Exceptions == region_exc0)
        {
#ifdef __EMSCRIPTEN__
          // [collapse] per-block ownership: bail the multi-block region loop the instant the worker owns.
          if (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u) break;
#endif
          const u32 region_cur = ppc_state.pc;
          s32 rnext = 0;
          if (!m_wasm_cache.region_dispatch(region_cur, &rnext))
            break;
          ppc_state.pc  = static_cast<u32>(rnext);
          ppc_state.npc = static_cast<u32>(rnext);
          // A direct self-cycle (region dispatch returns its own entry pc) is an
          // idle poll or a CTR self-loop — hand it to chain_dispatch.
          if (static_cast<u32>(rnext) == region_cur)
            break;
          // <=16-PC cycle streak: force a CoreTiming slice end so Advance runs.
          {
            const u32 np = static_cast<u32>(rnext);
            bool m = false;
            for (u32 j = 0; j < 16u; ++j) { if (np == r_last[j]) { m = true; break; } }
            if (m)
            {
              if (++r_streak >= 8) {
                ppc_state.downcount = 0; break;
              }
            }
            else
            {
              r_streak = 0;
            }
            r_last[r_idx & 15] = np;
            ++r_idx;
          }
        }
      }

      const u32 pc = ppc_state.pc;

      // CHAIN DISPATCH (2026-06-12): run cached blocks back-to-back inside
      // ONE EM_ASM loop (block_cache.cpp chain_dispatch_raw) instead of one
      // host round-trip per block. Pre-chain measurement (PSO, [pc-census]):
      // ~930K dispatches/s wall with ~7-instruction blocks — the round trip
      // per block WAS the throughput wall once HandleReverb's loop went
      // fully native. Blocks self-account downcount in their prologue
      // (build_block_next emits downcount -= numCycles; the C-side
      // decrement that lived here is gone — double-charge otherwise). The
      // chain bails on: cache miss, max_iters, wasm trap, pending
      // ppc_state.Exceptions (set by in-block imports), or downcount <= 0;
      // this loop then services CoreTiming / CheckExceptions exactly as it
      // did between single dispatches.
      u32 final_pc = pc;
      u32 trap_pc = 0;
#ifdef __EMSCRIPTEN__
      // [self-loop PM47] every HOST-initiated dispatch invalidates the
      // self-chain flag: the flag may only be honored across a DIRECT
      // self-tail-call (anything host-side — interp, exceptions, regions —
      // could have rewritten ps[], making the scratch stale).
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B38C0u)) = 0u;
#endif
      const s32 chained = m_wasm_cache.chain_dispatch(
          pc, /*max_iters=*/4096u, &final_pc, &trap_pc,
          &ppc_state.Exceptions, reinterpret_cast<const s32*>(&ppc_state.downcount));
#ifdef __EMSCRIPTEN__
      // [single-spec PM26] A block's single-valued prologue guard mismatched:
      // it published its pc, zeroed the downcount (which broke the chain), and
      // returned its own start. Evict + sticky-force-double so the recompile
      // drops the assumption — once per pc, converges.
      {
        volatile u32* dcell =
            reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B33E4u));
        const u32 dp = *dcell;
        if (dp != 0u)
        {
          *dcell = 0u;
          bem_pc_force_double_add(dp);
          EvictBlock(dp);
          volatile u32* dn =
              reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B33E8u));
          *dn = *dn + 1u;   // cumulative deopt count (probe: simdCensus tail)
        }
      }
#endif
      if (trap_pc != 0u)
      {
        // A block trapped mid-chain. chain_dispatch already evicted it
        // from the block cache; drop our per-pc metadata, resume the
        // interpreter at the trapped block's start (its in-block set_pc
        // writes were per-op, but block-start resume matches the old
        // single-dispatch trap behavior).
        m_block_inst_counts.erase(trap_pc);
        m_block_guest_end.erase(trap_pc);
        ppc_state.pc = trap_pc;
        ppc_state.npc = trap_pc;
#ifdef __EMSCRIPTEN__
        // [single-spec PM26] the host interpreter may write ps[] — the shadow
        // mask is stale for anything it touches; clear wholesale.
        *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B33E0u)) = 0u;
        // [self-loop PM47] scratch stale with the mask — invalidate the flag too.
        *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B38C0u)) = 0u;
#endif
        CachedInterpreter::Run();
        return;
      }

      if (chained > 0)
      {
        const s32 next_pc = static_cast<s32>(final_pc);

        // Self-dispatch idle-skip — when emit_idle_skip marked the block's
        // terminator as branchIsIdleLoop, the analyzer collapsed the bcx
        // (e.g. SAB 0x800ecb48 mftbu/mftbl/mftbu/cmpw/bne-$-16 TBU-retry)
        // to next_pc == op.address with no fallthrough check. Without the
        // floor below, the inner loop burns ~600 dispatches before
        // downcount goes negative and the outer loop's CoreTiming::Advance
        // updates TBU — that's the wedge symptom (pc=0x800ecb48
        // dispatched 46M times in 60s, 2026-05-31). Force downcount <= 0
        // so the inner do-while exits THIS iteration; outer Advance runs,
        // ticks TBU, next dispatch reads a fresh upper, cmpw can mismatch
        // and the loop exits. Matches Jit64's idle-skip behavior.
        //
        // Also extend to short-cycle loops (k=2..4): SAB 0x800e4c5c → bl
        // OSGetTick(0x800ecb60: mftb r3; blr) → 0x800e4c60 (subf/cmpw/blt
        // 0x800e4c5c) is a 3-PC cycle with no self-dispatch but is
        // semantically an idle-spin on mftb. Same problem class — without
        // forcing Advance, TBL never ticks. Track last 4 next_pc values;
        // if `next_pc` matches any → we just closed a ≤4-PC cycle → idle.
        {
          const u32 np = static_cast<u32>(next_pc);
          // [xinst-fix] 16-deep (was 4): the OS scheduler/idle cluster is a ~9-PC
          // cycle that a 4-deep ring can never match 8x — so it never idle-skips
          // and crawls at ~2.5M ticks/s. 16 recognizes scheduler-length cycles.
          bool ring_match = (np == pc);
          if (!ring_match)
            for (u32 j = 0; j < 16u; ++j) { if (np == last_next[j]) { ring_match = true; break; } }
          // STREAK GATE (2026-06-11, v2 of the wake-starvation fix): a real
          // idle spin (mftb TBU-retry, 0x800e4c5c 3-PC poll) matches the
          // ring thousands of consecutive iterations; a woken thread's
          // scheduler-unwind matches it incidentally (~once per wake,
          // interleaved with fresh PCs). Firing downcount=0 on EVERY match
          // time-warped CoreTiming straight to the next pending DSP-mail
          // event during the unwind, preempting main at a deterministic
          // depth (index 33, 31/31 [ax-wake-traj] windows) so it NEVER
          // reached VIWaitForRetrace's re-check (GlobalCounter pinned 0;
          // native completes the phase in 65ms with the same mail cadence).
          // Require 8 consecutive matches before forcing Advance: idle
          // spins hit that within microseconds, wake paths never do.
          if (ring_match)
          {
            if (++ring_streak >= 8)
            {
              ppc_state.downcount = 0;
            }
          }
          else
          {
            ring_streak = 0;
          }
          last_next[last_idx & 15] = np;
          ++last_idx;
        }

        ppc_state.pc  = static_cast<u32>(next_pc);
        ppc_state.npc = ppc_state.pc;
        continue;
      }

      // Cache miss. Try to compile a block at this PC.
      if (TryCompileBlock(pc, ctx_ptr, mem1_base, mem1_mask, ram_size))
      {
        // Compile produced a cached entry. Loop and retry dispatch.
        continue;
      }

      // Compile failed (decode hit unsupported stream, build_block_next
      // returned empty, or m_wasm_cache.compile rejected the bytes). Fall
      // back to upstream CachedInterpreter::Run for the rest of this slice.
      // CachedInterpreter has its own outer Advance loop and yields to
      // CoreTiming when budget exhausts; returning out of our Run lets
      // RunSingleFrame complete the frame.
      // [npc-sync — root fix of the PC=0 ISI] The chain advanced ppc_state.pc per block but left npc
      // at the chain's ENTRY pc (bem_chain_loop_c/chain_dispatch_raw never touch npc); the chained>0
      // path re-syncs at line ~500 but THIS compile-fail fallback did not. CachedInterpreter checks
      // exceptions at entry via ppc_state.npc, so a stale npc (0x80010640, an old HuSprDisp epilogue)
      // -> SRR0=npc -> rfi to a dead frame -> blr 0. pc is the real resume instruction; force npc=pc.
      ppc_state.npc = ppc_state.pc;
#ifdef __EMSCRIPTEN__
      // [single-spec PM26] see the trap path — interp may write ps[].
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B33E0u)) = 0u;
        // [self-loop PM47] scratch stale with the mask — invalidate the flag too.
        *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B38C0u)) = 0u;
#endif
      CachedInterpreter::Run();
      return;
    } while (ppc_state.downcount > 0 && *state_ptr == CPU::State::Running);
  }
}

bool JitWasm::TryCompileBlock(u32 start_pc, u32 ctx_ptr, u32 mem1_base,
                              u32 mem1_mask, u32 ram_size)
{
  auto& mem = m_system.GetMemory();

  // Decode block: read guest instructions starting at start_pc until we hit
  // a branch terminator or the inst cap. Read failures terminate immediately;
  // build_block_next is responsible for producing a valid wasm body or
  // returning empty.
  std::vector<u32> insts;
  insts.reserve(kMaxBlockInsts);
  u32 pc = start_pc;
  for (u32 i = 0; i < kMaxBlockInsts; ++i)
  {
    // Read_U32 routes through the same MMU path as the interpreter would.
    // Under wasm with our flat-MemArena layout, this is a single masked
    // load (Memmap.cpp's m_ram[ea & ram_mask]); under future fastmem
    // arrangements it'd stay correctness-preserving.
    const u32 inst = mem.Read_U32(pc);
    insts.push_back(inst);
    // [coalesce] Keep decoding past a FORWARD conditional branch (emitted as a
    // mid-block conditional exit; the not-taken fall-through stays in this
    // block). MUST use the same predicate as PPCAnalyzer::Analyze so the
    // decoded count matches the analyst length. Backward/self conditionals and
    // all unconditional terminators still end the block.
    if (IsBlockTerminator(inst) &&
        !bemental::powerpc::IsForwardConditionalBranch(inst, pc))
      break;
    pc += 4u;
  }

  if (insts.empty())
    return false;

  const u32 count = static_cast<u32>(insts.size());

  // Hand to bementalJIT's canonical Phase-4 emit. Signature per
  // guests/powerpc-next/ppc_emit.h:52-55. block_cycles receives the
  // analyzer's opinfo num_cycles sum (PPCAnalyzer stats.numCycles).
  u32 block_cycles = 0;
  std::vector<u8> bytes;
  bool used_aot = false;

  // [AOT A1] Prebuilt-block swap via HASH-MATCHED registration. build_block_next
  // is context-sensitive (identical guest insts emit different wasm depending on
  // runtime state: HLE-wrapping, lc-specialization, singles-spec) — proven by
  // measurement — so we CANNOT authenticate by re-emitting and byte-comparing.
  // Instead we hash the LIVE-decoded guest instruction words and match them
  // against the asset's per-block (gspan, ghash): this confirms the guest code
  // at start_pc is exactly what we compiled offline. The offline block is the
  // UNSPECIALIZED general path (lc_base=0, slowmem) — golden-validated correct
  // in ALL runtime states. With a guest-hash match, a matching baked_ctx, and
  // the KILL switch off, we register the prebuilt bytes instead of JIT'ing.
  // Any mismatch falls through to the normal JIT emit — the swap is never unsafe.
  if (g_aot_loaded && *AotCell(0x026B3474u) == 0u)
  {
    auto it = g_aot_blocks.find(start_pc);
    if (it != g_aot_blocks.end())
    {
      *AotCell(0x026B3484u) = ctx_ptr;  // publish the live &ppc_state (bake target)
      const bool ctx_ok  = (g_aot_baked_ctx == ctx_ptr);
      // Authenticate the guest code: span + FNV hash (fast pre-filter) THEN a
      // full word-for-word compare (collision-proof authority). The offline tool
      // stores the exact guest words the block was compiled from.
      bool hash_ok = (count == it->second.gspan &&
                      AotGuestHash(insts.data(), count) == it->second.ghash &&
                      it->second.gwords.size() == count);
      for (u32 i = 0; hash_ok && i < count; ++i)
        if (insts[i] != it->second.gwords[i]) hash_ok = false;
      if (hash_ok && ctx_ok)
      {
        bytes = it->second.wasm;
        block_cycles = it->second.cycles;
        used_aot = true;
        AotBump(0x026B3478u);  // hit
      }
      else
      {
        if (!hash_ok) AotBump(0x026B347Cu);  // guest-hash mismatch
        if (!ctx_ok)  AotBump(0x026B3480u);  // ctx mismatch
      }
    }
  }

  if (!used_aot)
  {
    bytes = bemental::powerpc::build_block_next(
        start_pc, insts.data(), count, ctx_ptr, mem1_base, mem1_mask, ram_size,
        &block_cycles);
  }

  if (bytes.empty())
    return false;

  const int handle = m_wasm_cache.compile(static_cast<u64>(start_pc),
                                          bytes.data(), bytes.size());
  if (handle < 0)
    return false;

  // Jit64 parity (Jit.cpp js.downcountAmount = sum of opinfo->num_cycles):
  // charge the block's REAL cycle cost, not 1/instruction. The 1/instr
  // accounting skewed every CoreTiming-relative cadence (VI/DSP/audio
  // events vs guest instruction progress) — found by the 2026-06-11
  // exhaustive Jit64 parity audit (docs/jit-correctness-rulebook/).
  m_block_inst_counts[start_pc] = block_cycles ? block_cycles : count;
  // Guest span for icbi range-eviction (InvalidateICacheRange).
  m_block_guest_end[start_pc] = start_pc + count * 4u;

  // STEP 2 (region wiring, side-channel — NO dispatch change yet): accumulate
  // this block's bare BODY (no module wrapper) into its region so a later
  // region_relink can merge contiguous blocks into ONE wasm function with
  // internal br_table dispatch, eliminating the per-block JS Map.get +
  // cross-instance run() round-trip. First-emit intra-region branches are
  // unresolved (lookup_fn=null); region_relink re-emits each stored body with
  // the up-to-date pc_to_idx map. region_dispatch is NOT called here, so this
  // is pure side-channel: steady-state fps/cycles must stay at the baseline.
  {
    // Hot-only merge (step 2, revised): stash this block's emit inputs only
    // (NO body emitted at compile, NO accumulate-all). promote_hot re-emits +
    // merges it into the hot region once it has been dispatched enough times,
    // so the merged region stays small (the hot loop), not all ~8900 blocks.
    bemental::BlockEmitInputs rec;
    rec.start_pc      = start_pc;
    rec.ctx_ptr_const = ctx_ptr;
    rec.mem1_base     = mem1_base;
    rec.mem1_mask     = mem1_mask;
    rec.ram_size      = ram_size;
    rec.block_cycles  = block_cycles ? block_cycles : count;
    rec.insts         = insts;
    rec.instr_pcs.resize(count);
    for (u32 i = 0; i < count; ++i)
      rec.instr_pcs[i] = start_pc + i * 4u;
    m_wasm_cache.stash_block(start_pc, rec);
  }
  return true;
}

#endif  // __EMSCRIPTEN__
