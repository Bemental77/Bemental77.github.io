// Copyright 2026 Dolphin Emulator Project (bementalCompiler integration)
// SPDX-License-Identifier: GPL-2.0-or-later
//
// JitWasm — bementalCompiler-driven Gekko→WASM JIT for browser builds.
//
// Inherits from CachedInterpreter so we get all the JitBase boilerplate
// (block cache, MMU coupling, Jit(), HandleFault, etc.) for free. Owns an
// extra bemental::BlockCache that holds compiled WebAssembly modules keyed
// by guest PC. The Run() override drives the WASM dispatcher — on each
// step:
//   1. Look up the current guest PC in m_wasm_cache; on hit, dispatch the
//      cached WASM module and advance PC to its returned next-PC.
//   2. On miss, decode a block starting at PC, hand the instruction stream
//      to bemental::powerpc::build_block_next, compile the produced wasm,
//      cache under PC, retry dispatch.
//   3. On compile failure or unsupported instruction stream, fall back to
//      CachedInterpreter::Run for the remainder of this slice.
// Exceptions / downcount are owned by upstream PowerPCManager — Run yields
// to CoreTiming when downcount expires or CPU::State leaves Running.

#pragma once

#ifdef __EMSCRIPTEN__

#include <unordered_map>

#include "Common/CommonTypes.h"
#include "Core/PowerPC/CachedInterpreter/CachedInterpreter.h"

#include "bementalJIT/block_cache.h"

class JitWasm final : public CachedInterpreter
{
public:
  explicit JitWasm(Core::System& system) : CachedInterpreter(system) {}
  ~JitWasm() override = default;

  JitWasm(const JitWasm&) = delete;
  JitWasm(JitWasm&&) = delete;
  JitWasm& operator=(const JitWasm&) = delete;
  JitWasm& operator=(JitWasm&&) = delete;

  void Init() override;
  void Shutdown() override;
  void Run() override;
  const char* GetName() const override { return "WASM JIT (bementalCompiler)"; }

private:
  // Decode a basic block starting at start_pc (terminator is the first
  // branch opcode encountered, or 64 instructions, whichever comes first).
  // Hands the decoded stream to bemental::powerpc::build_block_next, compiles
  // the result into m_wasm_cache under key=start_pc. Returns true if a
  // cached entry now exists for start_pc; false if decode/build/compile
  // produced no usable entry (caller falls back to interpreter).
  bool TryCompileBlock(u32 start_pc, u32 ctx_ptr, u32 mem1_base, u32 mem1_mask,
                       u32 ram_size);

  // Compiled WebAssembly modules, keyed by guest PC. Lifetime tracks the
  // JitWasm instance.
  bemental::BlockCache m_wasm_cache;

  // Per-block instruction count, captured at compile time so dispatch can
  // decrement downcount by the right number of cycles (1 cycle per guest
  // instruction matches Interpreter::SingleStep accounting). Sparse — only
  // populated for PCs we've compiled.
  std::unordered_map<u32, u32> m_block_inst_counts;
};

#endif  // __EMSCRIPTEN__
