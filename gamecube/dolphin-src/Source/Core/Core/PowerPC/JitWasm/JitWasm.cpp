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

#include "Common/CommonTypes.h"
#include "Core/HW/CPU.h"
#include "Core/HW/Memmap.h"
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

// True iff the primary opcode is a branch that terminates a basic block.
//   18  = b   (op_b)
//   16  = bc  (op_bcx — conditional)
//   19  = bclr / bcctr / rfi / isync / sub-ops (op_branch_19)
// rfi (op 19 xo=50) and sc (op 17) also end blocks. sc is rare enough to
// catch via the conservative break. The bementalJIT analyzer applies the
// same cut.
inline bool IsBlockTerminator(u32 inst)
{
  const u32 primary = PrimaryOp(inst);
  return primary == 16u || primary == 17u || primary == 18u || primary == 19u;
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

void JitWasm::Run()
{
  auto& mem = m_system.GetMemory();
  auto& ppc_state = m_ppc_state;
  const CPU::State* state_ptr = m_system.GetCPU().GetStatePtr();

  // bementalJIT compile inputs. ctx_ptr / mem1_base are wasm linear-memory
  // offsets — under wasm32 these are u32-cast host pointers (the wasm
  // module's linear memory IS the host address space for this process).
  const u32 ctx_ptr   = static_cast<u32>(reinterpret_cast<uintptr_t>(&ppc_state));
  const u32 mem1_base = static_cast<u32>(reinterpret_cast<uintptr_t>(mem.GetRAM()));
  const u32 mem1_mask = mem.GetRamMask();
  const u32 ram_size  = mem.GetRamSize();

  // Outer slice loop. Yields back to PowerPCManager when downcount expires
  // or CPU state leaves Running — at which point CoreTiming::Advance runs
  // and we're re-entered.
  while (ppc_state.downcount > 0 && *state_ptr == CPU::State::Running)
  {
    // Pending exceptions: let upstream CheckExceptions transition PC to the
    // handler vector; the next iteration dispatches the handler block.
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
      // Hit. INT32_MIN sentinel = the dispatched block trapped at runtime
      // (block_cache.cpp's dispatch_raw try/catch returns it on any wasm
      // exception). Evict so the next iteration re-compiles, then bail to
      // the interpreter for one slice — the interpreter is responsible for
      // surfacing whatever underlying fault caused the trap.
      if (next_pc == std::numeric_limits<s32>::min())
      {
        m_wasm_cache.evict(pc);
        m_block_inst_counts.erase(pc);
        CachedInterpreter::Run();
        return;
      }

      // Decrement downcount by the block's compile-time instruction count
      // (1 cycle/instr — matches Interpreter::SingleStep accounting). If
      // somehow the count is missing (race / explicit cache clear elsewhere),
      // use 1 as a conservative floor so we always make progress.
      auto it = m_block_inst_counts.find(pc);
      const u32 cycles = (it != m_block_inst_counts.end()) ? it->second : 1u;
      ppc_state.downcount -= static_cast<int>(cycles);

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
    // CachedInterpreter has its own downcount loop and yields to CoreTiming
    // when budget exhausts; we don't re-enter our loop until the next
    // outer scheduler tick.
    CachedInterpreter::Run();
    return;
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
