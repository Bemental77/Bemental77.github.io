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

#include <climits>
#include <cstdint>
#include <vector>

#include <emscripten.h>

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

#include "bementalJIT/types.h"
#include "ppc_analyst.h"  // bemental::powerpc::IsBlockTerminator — single source of truth.
#include "ppc_emit.h"     // bementalJIT/guests/powerpc-next/ppc_emit.h (PUBLIC include dir)

namespace
{
// Block-decode limit. Matches the conservative cap the legacy build_block
// path used. Branches always terminate; this is the upper bound for
// fall-through fetch.
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
  CachedInterpreter::Shutdown();
}

void JitWasm::ClearCache()
{
  // Drop both caches together so a subsequent dispatch re-compiles with
  // current state (HLE patches installed, regcache assumptions reset,
  // etc.). Called from JitInterface::ClearCache via the inherited virtual.
  m_wasm_cache.clear();
  m_block_inst_counts.clear();
  CachedInterpreter::ClearCache();
}

void JitWasm::EvictBlock(u32 pc)
{
  m_wasm_cache.evict(pc);
  m_block_inst_counts.erase(pc);
}

// C-linkage helper for the bridge (dolphin-bridge can't include JitWasm.h
// because that pulls bementalJIT/block_cache.h via the m_wasm_cache
// member, and the bridge's link-step compile doesn't have the bementalJIT
// include path). Defined here in JitWasm.cpp where the full type is in
// scope. Callable from dolphin-bridge as `extern "C" void
// dolphin_evict_block(uint32_t)`.
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
    // Start new timing slice. Refills downcount; scheduled events fire
    // here (VI, AI, DSP, etc.). NOTE: Advance may set Exceptions / change PC.
    core_timing.Advance();

    // Per-slice idle-skip ring. Must be SLICE-LOCAL (not static), or PCs
    // from a real idle loop in one slice will throttle unrelated blocks
    // in subsequent slices: any block whose next_pc happens to match a
    // stale ring entry incorrectly triggers downcount=0, forcing a one-
    // block-per-slice cadence on unrelated code. Bug found by branch-
    // emit audit 2026-06-07; was previously declared `static` causing
    // process-lifetime contamination of the heuristic.
    u32 last_next[4] = {0, 0, 0, 0};
    u32 last_idx = 0;

    do
    {
      // Pending exceptions: let upstream CheckExceptions transition PC to
      // the handler vector; the next iteration dispatches the handler.
      if (ppc_state.Exceptions != 0)
      {
        m_system.GetPowerPC().CheckExceptions();
        if (*state_ptr != CPU::State::Running)
          return;
        // Fall through; pc may now be at a vector (0x400/0x500/etc).
      }

      const u32 pc = ppc_state.pc;
      s32 next_pc = 0;

      if (m_wasm_cache.dispatch(pc, &next_pc))
      {
        // Hit. INT32_MIN sentinel = the dispatched block trapped at
        // runtime (block_cache.cpp dispatch_raw try/catch returns it on
        // any wasm exception). Evict so the next iteration re-compiles,
        // then bail to the interpreter for the rest of this slice — the
        // interpreter is responsible for surfacing whatever underlying
        // fault caused the trap.
        if (next_pc == std::numeric_limits<s32>::min())
        {
          m_wasm_cache.evict(pc);
          m_block_inst_counts.erase(pc);
          CachedInterpreter::Run();
          return;
        }

        // Decrement downcount by the block's compile-time instruction
        // count (1 cycle/instr — matches Interpreter::SingleStep
        // accounting). If somehow the count is missing (race / explicit
        // cache clear elsewhere), use 1 as a conservative floor.
        auto it = m_block_inst_counts.find(pc);
        const u32 cycles = (it != m_block_inst_counts.end()) ? it->second : 1u;
        ppc_state.downcount -= static_cast<int>(cycles);

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
          if (np == pc || np == last_next[0] || np == last_next[1] ||
              np == last_next[2] || np == last_next[3])
          {
            ppc_state.downcount = 0;
          }
          last_next[last_idx & 3] = np;
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
    if (IsBlockTerminator(inst))
      break;
    pc += 4u;
  }

  if (insts.empty())
    return false;

  const u32 count = static_cast<u32>(insts.size());

  // Hand to bementalJIT's canonical Phase-4 emit. Signature per
  // guests/powerpc-next/ppc_emit.h:52-55.
  std::vector<u8> bytes = bemental::powerpc::build_block_next(
      start_pc, insts.data(), count, ctx_ptr, mem1_base, mem1_mask, ram_size);

  if (bytes.empty())
    return false;

  const int handle = m_wasm_cache.compile(static_cast<u64>(start_pc),
                                          bytes.data(), bytes.size());
  if (handle < 0)
    return false;

  m_block_inst_counts[start_pc] = count;
  return true;
}

#endif  // __EMSCRIPTEN__
