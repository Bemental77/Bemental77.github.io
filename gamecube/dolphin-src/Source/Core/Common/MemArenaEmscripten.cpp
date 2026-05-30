// Copyright 2026 Dolphin Emulator Project (emscripten port — bementalJIT integration)
// SPDX-License-Identifier: GPL-2.0-or-later
//
// MemArena under Emscripten / WebAssembly.
//
// Native dolphin's MemArenaUnix.cpp uses shm_open + mmap(MAP_FIXED | MAP_SHARED) to
// (a) back the SHM segment with a kernel shared-memory object and (b) alias that
// SHM into multiple virtual addresses for the Jit64/JitArm64 fastmem fast path.
// Under emscripten/wasm32, neither primitive is usable: shm_open returns -1 (emcc
// upstream #5928 closed wontfix; #17801, #21706 open), and mmap(MAP_FIXED) cannot
// produce multiple-view aliasing because each wasm module has one flat linear
// memory with no kernel mmap layer.
//
// Per /tmp/memarena-research/PLAN.md (synthesis of 4 deep-research reports), the
// architectural-decoupling finding is:
//
//   * Half A — freestanding views (m_ram, m_l1_cache, m_fake_vmem) — load-bearing
//     for our build; CachedInterpreter accesses MEM1 as m_ram[em_address &
//     GetRamMask()] (MMU.cpp:255-273), and bementalJIT emits inline
//     (EA & 0x01FFFFFF) + mem1_base loads (jit_load_store.cpp:161-189). No aliasing
//     needed at the host VM layer; the cached/uncached BAT mirrors collapse via
//     software TranslateAddress (MMU.cpp:222) before indexing m_ram.
//
//   * Half B — fastmem arena (18 GiB host VA, MAP_FIXED-aliased views) — used only
//     by Jit64/JitArm64's pointer-arithmetic shortcut. JitWasm / CachedInterpreter /
//     bementalJIT do not consume any fastmem-arena symbol (verified by grep -r
//     'GetLogicalBase\|GetPhysicalBase\|m_fastmem_arena' across gamecube/bementalJIT/
//     and gamecube/dolphin-bridge/ at commit 270e38c → zero hits).
//
// This file implements Half A with malloc-backed storage and pointer-arithmetic
// views, and returns nullptr/false for every Half B method. Memmap::InitFastmemArena
// short-circuits to `return false` under __EMSCRIPTEN__ (HW/Memmap.cpp, same commit
// as this file), so the unreachable 4 GiB ppc_view_size constant in that function
// (Memmap.cpp:212) — which truncates to 0 on wasm32 due to size_t being 32-bit —
// never matters.
//
// Behavioral contract preserved vs MemArenaUnix.cpp:
//
//   GrabSHMSegment(size, _)  — allocates a region of `size` bytes that subsequent
//                              CreateView calls index into. malloc-backed; no
//                              cross-process shared memory (irrelevant — wasm
//                              modules are single-process by definition).
//
//   CreateView(off, size)    — returns m_shm_buf + off (no allocation; just a
//                              pointer into the same backing buffer). Two
//                              CreateView calls with the same offset return the
//                              same pointer (writes through one are observable
//                              through the other), which preserves the only
//                              behavioral guarantee CachedInterpreter / bementalJIT
//                              actually use.
//
//   ReleaseView(_, _)        — no-op (the underlying buffer is owned by m_shm_buf
//                              and freed only by ReleaseSHMSegment).
//
//   ReserveMemoryRegion(_)   — returns nullptr. The fastmem arena is unavailable
//                              under wasm. Caller (Memmap::InitFastmemArena) is
//                              short-circuited to return false before reaching here.
//
//   MapInMemoryRegion(...)   — returns nullptr.
//   ChangeMappingProtection  — returns false.
//   UnmapFromMemoryRegion(_) — no-op.
//
//   GetPageSize()            — returns 65536 (wasm linear-memory page size; matches
//                              sysconf(_SC_PAGESIZE) under emcc/musl).
//
//   LazyMemoryRegion         — backed by calloc-zeroed buffer + memset on Clear.

#include "Common/MemArena.h"

#include <cstdlib>
#include <cstring>

#include "Common/CommonTypes.h"
#include "Common/Logging/Log.h"

namespace Common
{
MemArena::MemArena() = default;
MemArena::~MemArena() = default;

void MemArena::GrabSHMSegment(size_t size, std::string_view /*base_name*/)
{
  m_shm_buf = std::malloc(size);
  if (!m_shm_buf)
  {
    ERROR_LOG_FMT(MEMMAP, "MemArenaEmscripten: malloc({}) failed for SHM segment", size);
    m_shm_size = 0;
    return;
  }
  m_shm_size = size;
  // Match shm_open's O_CREAT semantics — buffer starts zeroed.
  std::memset(m_shm_buf, 0, size);
}

void MemArena::ReleaseSHMSegment()
{
  std::free(m_shm_buf);
  m_shm_buf = nullptr;
  m_shm_size = 0;
}

void* MemArena::CreateView(s64 offset, size_t size)
{
  if (!m_shm_buf)
    return nullptr;
  if (offset < 0 || static_cast<size_t>(offset) + size > m_shm_size)
  {
    NOTICE_LOG_FMT(MEMMAP, "MemArenaEmscripten::CreateView out of range: offset={} size={} shm_size={}",
                   offset, size, m_shm_size);
    return nullptr;
  }
  return static_cast<u8*>(m_shm_buf) + offset;
}

void MemArena::ReleaseView(void* /*view*/, size_t /*size*/)
{
  // No-op. The underlying buffer is owned by m_shm_buf and freed by ReleaseSHMSegment.
  // CreateView returned a pointer into that buffer, not an independent allocation.
}

u8* MemArena::ReserveMemoryRegion(size_t /*memory_size*/)
{
  // Fastmem arena unavailable under wasm. Caller (Memmap::InitFastmemArena) is
  // expected to be short-circuited to `return false` under __EMSCRIPTEN__ before
  // reaching this method. Returning nullptr here preserves the same failure mode
  // if the short-circuit were ever removed: InitFastmemArena would PanicAlertFmt
  // and return false anyway.
  return nullptr;
}

void MemArena::ReleaseMemoryRegion()
{
  // No-op (Reserve never succeeded).
}

void* MemArena::MapInMemoryRegion(s64 /*offset*/, size_t /*size*/, void* /*base*/, bool /*writeable*/)
{
  return nullptr;
}

bool MemArena::ChangeMappingProtection(void* /*view*/, size_t /*size*/, bool /*writeable*/)
{
  return false;
}

void MemArena::UnmapFromMemoryRegion(void* /*view*/, size_t /*size*/)
{
  // No-op.
}

size_t MemArena::GetPageSize() const
{
  // Wasm linear memory grows in 64 KiB pages (one WebAssembly.Memory page). This
  // matches sysconf(_SC_PAGESIZE) under emcc/musl, but pinning the value here
  // makes the contract explicit and removes a sysconf round-trip.
  return 65536;
}

// ---------------------------------------------------------------------------
// LazyMemoryRegion — under native dolphin this maps a private anonymous region
// with MAP_NORESERVE so pages are only physically committed on first access.
// Under emcc/wasm there's no equivalent NORESERVE primitive (linear memory is
// fully reserved at module instantiation). Substitute calloc + memset; the
// only behavioral guarantee callers rely on is "zero-initialised on Create and
// after Clear" — see Common/MemArena.h:160-161 contract.
// ---------------------------------------------------------------------------

LazyMemoryRegion::LazyMemoryRegion() = default;

LazyMemoryRegion::~LazyMemoryRegion()
{
  Release();
}

void* LazyMemoryRegion::Create(size_t size)
{
  if (size == 0)
    return nullptr;
  void* mem = std::calloc(1, size);  // zero-initialised per contract
  if (!mem)
  {
    NOTICE_LOG_FMT(MEMMAP, "LazyMemoryRegion::Create({}) failed (calloc returned null)", size);
    return nullptr;
  }
  m_memory = mem;
  m_size = size;
  return mem;
}

void LazyMemoryRegion::Clear()
{
  if (!m_memory)
    return;
  std::memset(m_memory, 0, m_size);
}

void LazyMemoryRegion::Release()
{
  if (m_memory)
  {
    std::free(m_memory);
    m_memory = nullptr;
    m_size = 0;
  }
}

}  // namespace Common
