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
#include "Core/HW/CPU.h"
#include "Core/HW/Memmap.h"
#include "Core/PowerPC/JitInterface.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"

#include "bementalJIT/types.h"
#include "ppc_emit.h"  // bementalJIT/guests/powerpc-next/ppc_emit.h (PUBLIC include dir)

namespace
{
// Block-decode limit. Matches the conservative cap the legacy build_block
// path used. Branches always terminate; this is the upper bound for
// fall-through fetch.
constexpr u32 kMaxBlockInsts = 64;

// Primary-opcode helper — extract bits 0-5 (PowerPC ISA notation: the
// "primary op" field is in the top 6 bits of a 32-bit instruction).
inline u32 PrimaryOp(u32 inst)
{
  return (inst >> 26) & 0x3Fu;
}

// True iff the instruction terminates a basic block.
//   18 = b     (unconditional branch, op_bx)
//   16 = bc    (conditional branch, op_bcx)
//   17 = sc    (syscall — raises EXCEPTION_SYSCALL, transfers control)
//   19 = sub-coded. The extended opcode in bits 21-30 distinguishes:
//        16  = bclr  (branch-to-LR)        → terminate
//        50  = rfi   (return-from-interrupt) → terminate
//        528 = bcctr (branch-to-CTR)       → terminate
//        150 = isync (pipeline sync)       → NOT a branch, do NOT terminate
//        129/193/225/257/289/417/449 = crand/crandc/cror/.../crxor
//                                          → CR ops, do NOT terminate
//        0   = mcrf  (move CR field)       → NOT a branch, do NOT terminate
//
// Pre-2026-05-30 this returned true for ALL primary == 19, which mis-cut
// blocks at isync — most painfully ICEnable at 0x800e4f5c, whose 5-op
// body starts with isync and whose mfspr/ori/mtspr/blr never got decoded,
// so the emitted block returned op.address unchanged and JitWasm self-
// looped on it indefinitely (wasm2wat capture 2026-05-30 confirmed the
// block body was just prologue + set_pc + epilogue).
inline bool IsBlockTerminator(u32 inst)
{
  const u32 primary = PrimaryOp(inst);
  if (primary == 16u || primary == 17u || primary == 18u)
    return true;
  if (primary != 19u)
    return false;
  // Op 19: only the control-flow extended opcodes terminate a block.
  const u32 xo = (inst >> 1) & 0x3FFu;
  return xo == 16u   // bclrx  (branch-to-LR)
      || xo == 50u   // rfi    (return-from-interrupt)
      || xo == 528u; // bcctrx (branch-to-CTR)
}
}  // namespace

void JitWasm::Init()
{
  CachedInterpreter::Init();
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
        if (static_cast<u32>(next_pc) == pc)
          ppc_state.downcount = 0;

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
