// Copyright 2026 Dolphin Emulator Project (bementalCompiler integration)
// SPDX-License-Identifier: GPL-2.0-or-later
//
// JitWasm — bementalCompiler-driven Gekko→WASM JIT for browser builds.
//
// Initial wiring stage: Init/Shutdown/Run forward to CachedInterpreter so
// the new CPUCore enum, JitInterface dispatch route, and bementalJIT link
// surface can be validated end-to-end against a fresh upstream
// libretro/dolphin tree before the real WASM dispatch path lands.
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

void JitWasm::Init()
{
  CachedInterpreter::Init();
}

void JitWasm::Shutdown()
{
  CachedInterpreter::Shutdown();
}

void JitWasm::Run()
{
  // Initial wiring stage. The real WASM dispatcher consults m_wasm_cache,
  // compiles missing blocks via bemental::powerpc::build_block(), and
  // loops on the returned next-PC. Until that lands, run upstream's
  // CachedInterpreter so the rest of the build/boot path can be exercised
  // on the fresh tree.
  CachedInterpreter::Run();
}

#endif  // __EMSCRIPTEN__
