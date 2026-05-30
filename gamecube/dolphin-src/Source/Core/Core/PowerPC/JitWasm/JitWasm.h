// Copyright 2026 Dolphin Emulator Project (bementalCompiler integration)
// SPDX-License-Identifier: GPL-2.0-or-later
//
// JitWasm — bementalCompiler-driven Gekko→WASM JIT for browser builds.
//
// Inherits from CachedInterpreter so we get all the JitBase boilerplate
// (block cache, MMU coupling, Jit(), HandleFault, etc.) for free. Owns an
// extra bemental::BlockCache that holds compiled WebAssembly modules keyed
// by guest PC. The Run() override drives the WASM dispatcher — when a
// block is missing it decodes guest instructions, calls
// bemental::powerpc::build_block(), compiles the result, dispatches it,
// then loops on the returned next-PC.
//
// During the initial wiring stage Run() simply delegates to
// CachedInterpreter::Run(). This lets us validate that the new CPUCore
// enum value, the JitInterface dispatch path, and the bementalCompiler
// linkage all work end-to-end before turning on the real WASM path.

#pragma once

#ifdef __EMSCRIPTEN__

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
  // Compiled WebAssembly modules, keyed by guest PC. Held by the JitWasm
  // instance so its lifetime tracks the CPU core. The Run() loop above
  // will consult this cache once the real WASM dispatch path lands; in
  // the initial wiring stage it is allocated but unused.
  bemental::BlockCache m_wasm_cache;
};

#endif  // __EMSCRIPTEN__
