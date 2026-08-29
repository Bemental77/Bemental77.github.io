// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

// A JIT vertex loader for the Emscripten build.
//
// Why this exists: VideoCommon/CMakeLists.txt compiles VertexLoaderX64.cpp only
// under _M_X86_64 and VertexLoaderARM64.cpp only under _M_ARM_64. The wasm
// build configures with ENABLE_GENERIC=ON (build-wasm-4010/CMakeCache.txt:
// "ENABLE_GENERIC:BOOL=ON"), so dolphin-src/CMakeLists.txt:221-224 sets
// _M_GENERIC and neither _M_X86_64 nor _M_ARM_64 — before this change the
// generic else() branch of VideoCommon/CMakeLists.txt added NO vertex loader.
// So VertexLoaderBase::CreateVertexLoader fell through its #if chain with
// native_loader == nullptr and returned the SOFTWARE VertexLoader (the
// `if (!native_loader)` fallback, VertexLoaderBase.cpp:375-378), whose inner
// loop makes one indirect call per pipeline stage per vertex
// (VertexLoader.cpp:264-272).
//
// This class emits a single flat wasm function per vertex format via
// bementalJIT's WasmModuleBuilder and installs it with bemental::compile_raw,
// then calls it through a function-pointer cast (wasm32 function pointers ARE
// __indirect_function_table indices, so the toolchain lowers the call to
// call_indirect — same trick as gamecube/ppc-worker/ppc_worker_main.cpp:1517).
//
// It deliberately covers ONLY the formats measured to dominate MP4's board
// (97.6% of 443M vertices; see IsSupported). Everything else keeps using the
// software loader, which CreateVertexLoader selects when IsSupported() is false.

#pragma once

#ifdef __EMSCRIPTEN__

#include <cstdint>
#include <memory>
#include <pthread.h>
#include <vector>

#include "Common/CommonTypes.h"
#include "VideoCommon/VertexLoaderBase.h"

class VertexLoader;

// ---------------------------------------------------------------------------
// Runtime A/B toggles.
//
// getenv is dead in the worker (a cross-thread Module.ENV never reaches the
// EmuThread's C environ), so GC runtime flags ride reserved SAB scratch cells
// that the page writes from a ?bjit_* URL param — established pattern, see
// gamecube.html:532-540 (?bjit_fp_resident_loop -> 0x026B3408) and its reader
// at bementalJIT/guests/powerpc-next/ppc_emit.cpp:1177-1180.
//
// Cells picked from the unoccupied 0x026B3900..0x026B3BFC window (a repo-wide
// grep for 0x026B3xxx finds nothing between 0x026B38DC and 0x026B3C00). SAB is
// browser-zeroed, so 0 is the cold-boot default for every cell below. Absolute
// addressing into the shared heap from dolphin-src is already established here:
// Core/CoreTiming.cpp:705-720 does exactly this, unguarded.
//
// A/B recipe (ONE binary, ONE session — no rebuild between arms):
//   var A = new Uint32Array(sharedMemory.buffer);
//   A[0x026B3900 >> 2] = 0;   // arm A: wasm vertex loader (default)
//   A[0x026B3900 >> 2] = 1;   // arm B: stock software VertexLoader
// The toggle is honoured per-loader-creation AND per-RunVertices, so flipping it
// mid-scene switches paths immediately; no reboot, no reload.
// ---------------------------------------------------------------------------
namespace VertexLoaderWasmFlags
{
// 0 (default) = the emitted wasm loader is used for supported formats.
// nonzero     = every loader falls back to the stock software VertexLoader.
constexpr std::uintptr_t kForceSoftwareCell = 0x026B3900u;
// nonzero = force VertexLoaderType::Compare, running BOTH loaders and diffing
// them through VertexLoaderTester (VertexLoaderBase.cpp:106-272). Loaders are
// cached, so set this before the first draw.
constexpr std::uintptr_t kForceCompareCell = 0x026B3904u;
// Probe-readable results of the Compare gate (mirrors of the extern "C" globals
// in VertexLoaderBase.cpp; also reachable as Module._bem_vtx_mismatch_count()).
constexpr std::uintptr_t kMismatchCountCell = 0x026B3908u;
constexpr std::uintptr_t kMismatchKindsCell = 0x026B390Cu;
constexpr std::uintptr_t kCompareRunsCell = 0x026B3910u;

inline u32 ReadCell(std::uintptr_t cell)
{
  return *reinterpret_cast<volatile u32*>(cell);
}
inline void WriteCell(std::uintptr_t cell, u32 value)
{
  *reinterpret_cast<volatile u32*>(cell) = value;
}
inline bool ForceSoftware()
{
  return ReadCell(kForceSoftwareCell) != 0u;
}
inline bool ForceCompare()
{
  return ReadCell(kForceCompareCell) != 0u;
}
}  // namespace VertexLoaderWasmFlags

class VertexLoaderWasm final : public VertexLoaderBase
{
public:
  // True iff EmitModule() can reproduce this format bit-exactly. Checked by
  // VertexLoaderBase::CreateVertexLoader BEFORE constructing; when false the
  // existing software fallback runs unchanged.
  static bool IsSupported(const TVtxDesc& vtx_desc, const VAT& vtx_attr);

  VertexLoaderWasm(const TVtxDesc& vtx_desc, const VAT& vtx_attr);
  ~VertexLoaderWasm() override;

  int RunVertices(const u8* src, u8* dst, int count) override;

private:
  using VtxFn = int (*)(const u8* src, u8* dst, int count);

  // Lazily compiles for the CALLING thread. bemental::compile_raw registers the
  // emitted function into the calling thread's wasmTable
  // (bementalJIT/src/block_cache.cpp:149-157), and a wasm32 function pointer is
  // an index into the *own instance's* table — so a handle minted on thread A is
  // meaningless on thread B. Re-compiles if the caller changes.
  bool EnsureCompiled();

  std::vector<u8> EmitModule() const;

  // Reference software loader. Its m_native_vtx_decl is copied verbatim in the
  // ctor (VertexLoaderManager::GetOrCreateMatchingFormat memcmps the whole
  // PortableVertexDeclaration *including padding* — NativeVertexFormat.h:71-74 —
  // so recomputing the decl risks a spurious second NativeVertexFormat).
  // It also doubles as the fallback whenever codegen is unavailable.
  std::unique_ptr<VertexLoader> m_software;

  // Layout snapshot taken in the ctor (offsets are from the vertex base).
  u32 m_stride = 0;
  u32 m_pos_offset = 0;
  u32 m_normal_offset = 0;
  u32 m_color_offset = 0;
  u32 m_tex_offset = 0;
  bool m_has_color0 = false;
  bool m_has_tex0 = false;
  bool m_normal_is_float = false;  // else ComponentFormat::Byte (s8)

  // Codegen state, valid only for m_owner.
  VtxFn m_fn = nullptr;
  int m_handle = -1;
  pthread_t m_owner{};
  bool m_owner_valid = false;
  bool m_compile_failed = false;
};

#endif  // __EMSCRIPTEN__
