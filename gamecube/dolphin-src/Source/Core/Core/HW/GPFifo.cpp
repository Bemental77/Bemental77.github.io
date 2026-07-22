// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "Core/HW/GPFifo.h"

#include <cstddef>
#include <cstring>

#include "Common/ChunkFile.h"
#include "Common/CommonTypes.h"
#include "Common/Swap.h"
#include "Core/HW/Memmap.h"
#include "Core/HW/ProcessorInterface.h"
#include "Core/PowerPC/JitInterface.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"
#include "VideoCommon/CommandProcessor.h"

// [dual-core FIFO splice fix 2026-06-30] When set (by EmscriptenWorker run_iter_batch on a
// Phase-IV SET->CLEAR transition = the ISR excursion), GPFifo::Write* become no-ops so dolphin's
// CPU GX (the interrupt-handler overshoot) never reaches the shared FIFO and can't splice the
// worker's stream. Cleared on CLEAR->SET (worker re-engaged). Boot (Phase IV never set) keeps it.
extern "C" int g_gp_discard = 0;

namespace GPFifo
{
GPFifoManager::GPFifoManager(Core::System& system) : m_system(system)
{
}

// 32 Byte gather pipe with extra space
// Overfilling is no problem (up to the real limit), CheckGatherPipe will blast the
// contents in nicely sized chunks
//
// Other optimizations to think about:
// - If the GP is NOT linked to the FIFO, just blast to memory byte by word
// - If the GP IS linked to the FIFO, use a fast wrapping buffer and skip writing to memory
//
// Both of these should actually work! Only problem is that we have to decide at run time,
// the same function could use both methods. Compile 2 different versions of each such block?

size_t GPFifoManager::GetGatherPipeCount()
{
  return m_system.GetPPCState().gather_pipe_ptr - m_gather_pipe;
}

void GPFifoManager::SetGatherPipeCount(size_t size)
{
  m_system.GetPPCState().gather_pipe_ptr = m_gather_pipe + size;
}

void GPFifoManager::DoState(PointerWrap& p)
{
  p.Do(m_gather_pipe);
  u32 pipe_count = static_cast<u32>(GetGatherPipeCount());
  p.Do(pipe_count);
  SetGatherPipeCount(pipe_count);
}

void GPFifoManager::Init()
{
  ResetGatherPipe();
  m_system.GetPPCState().gather_pipe_base_ptr = m_gather_pipe;
  memset(m_gather_pipe, 0, sizeof(m_gather_pipe));
}

bool GPFifoManager::IsBNE() const
{
  // TODO: It's not clear exactly when the BNE (buffer not empty) bit is set.
  // The PPC 750cl manual says in section 2.1.2.12 "Write Pipe Address Register (WPAR)" (page 78):
  // "A mfspr WPAR is used to read the BNE bit to check for any outstanding data transfers."
  // In section 9.4.2 "Write Gather Pipe Operation" (page 327) it says:
  // "Software can check WPAR[BNE] to determine if the buffer is empty or not."
  // On page 327, it also says "The only way for software to flush out a partially full 32 byte
  // block is to fill up the block with dummy data,."
  // On page 328, it says: "Before disabling the write gather pipe, the WPAR[BNE] bit should be
  // tested to insure that all outstanding transfers from the buffer to the bus have completed."
  //
  // GXRedirectWriteGatherPipe and GXRestoreWriteGatherPipe (used for display lists) wait for
  // the bit to be 0 before continuing, so it can't be a case of any data existing in the FIFO;
  // it might be a case of over 32 bytes being stored pending transfer to memory? For now, always
  // return false since that prevents hangs in games that use display lists.
  return false;
}

void GPFifoManager::ResetGatherPipe()
{
  SetGatherPipeCount(0);
}

void GPFifoManager::UpdateGatherPipe()
{
  // [dc-diag 2026-07-21 TEMP] UpdateGatherPipe entry — is the gather-pipe flush being called
  // on the CPU thread's block epilogue? Remove after localizing the CP-FIFO break.
  { volatile u32* p = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1AF0u)); *p = *p + 1u; }
  auto& system = m_system;
  auto& memory = system.GetMemory();
  auto& processor_interface = system.GetProcessorInterface();

  size_t pipe_count = GetGatherPipeCount();
  size_t processed;
  // [wp-invariant 2026-07-10 — PERMANENT, the last shared cursor] The memcpy target (PI's
  // m_fifo_cpu_write_pointer) and the decoder's accounting (CP's CPWritePointer +
  // CPReadWriteDistance) are TWO pointer domains whose sync is ASSERT-only — compiled out
  // here. When they diverge, chunk bytes land at one address while distance credits
  // another: the decoder consumes a region that still holds ZEROS (= GX NOPs, silently
  // legal) and the real bytes arrive where nothing will ever decode them. Observed as the
  // armframe present-stall's final layer (fifo_window: 5-byte 'hole' mid-landing;
  // fifo_window2: intact-token-uncounted post-landing). Enforce the invariant at every
  // burst: the copy target IS the accounted pointer.
  {
    auto& cp_fifo = system.GetCommandProcessor().GetFifo();
    const u32 cp_wp = cp_fifo.CPWritePointer.load(std::memory_order_relaxed);
    const u32 cp_base = cp_fifo.CPBase.load(std::memory_order_relaxed);
    const bool linked = cp_fifo.bFF_GPLinkEnable.load(std::memory_order_relaxed) != 0;
    // [dc-diag 2026-07-21 TEMP] publish LIVE CP link/read/distance (UpdateGatherPipe runs
    // frequently, unlike the asleep RunGpuLoop) — is the CP FIFO enabled+linked under dual-core?
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1AD8u)) =
        cp_fifo.CPReadWriteDistance.load(std::memory_order_relaxed);
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1AE4u)) =
        cp_fifo.bFF_GPReadEnable.load(std::memory_order_relaxed) ? 1u : 0u;
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1AF8u)) = linked ? 1u : 0u;
    // [dc-diag TEMP] &m_fifo address + CPReadPointer/CPBase from the CPU/guest thread — compare
    // &fifo against the gpu_thread's (0x026B1B48). Same addr + different values => reset/coherence;
    // different addr => two System/CommandProcessor instances (the real root).
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1B4Cu)) = static_cast<u32>(reinterpret_cast<uintptr_t>(&cp_fifo));
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1B50u)) = cp_fifo.CPReadPointer.load(std::memory_order_relaxed);
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1B54u)) = cp_base;
    // [nonce STRIPPED 2026-07-22 — proved same-address coherence (PM11); done.]
    // [dl-fifo fix 2026-07-20] The wp-invariant only holds when the CPU FIFO and the CP (GP) FIFO
    // describe the SAME buffer (a genuinely LINKED GP FIFO). For a display-list / MEMORY FIFO the
    // guest UNLINKS the CP (GXSetCPUFifo else-branch -> __GXFifoLink(0)), so m_fifo_cpu_base (= the
    // DL heap buffer DLBufP) != CPBase (the GP FIFO base). Clobbering the DL write pointer with the
    // CP-domain cp_wp there misroutes one 32B burst to the GP FIFO while the accountant still
    // advances +32 -> the +32 DLBuf overflow that corrupts the heap free-list (MP4 gc=33 wedge).
    // bFF_GPLinkEnable can be STALE=1 during DL build (sync CTRL-write vs async GP-ring WGP-drain
    // race), so gate on same_buffer, not just on linked.
    const bool same_buffer = (processor_interface.m_fifo_cpu_base == cp_base);
    if (processor_interface.m_fifo_cpu_write_pointer != cp_wp && linked && same_buffer)
    {
      processor_interface.m_fifo_cpu_write_pointer = cp_wp;
    }
  }
  for (processed = 0; pipe_count >= GATHER_PIPE_SIZE; processed += GATHER_PIPE_SIZE)
  {
    // [domino3-wtgt 2026-07-16] dump each memcpy TARGET address (the guest FIFO addr this burst
    // lands at) so it can be diffed 1:1 against dolphin's READ addresses (ReadDataFromFifo) — if a
    // read chunk addr never appears as a write target, that chunk is STALE (misplaced-write proof).
    // Gated cpu_owner (inert on shipping). u32 targets at 0x026B2200, counter 0x026B21F0, first 96.
    if (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u)
    {
      volatile u32* wc = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B21F0u));
      const u32 wi = *wc;
      if (wi < 96u)
        *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2200u + wi * 4u)) =
            processor_interface.m_fifo_cpu_write_pointer;
      *wc = wi + 1u;
    }
    // copy the GatherPipe
    memory.CopyToEmu(processor_interface.m_fifo_cpu_write_pointer, m_gather_pipe + processed,
                     GATHER_PIPE_SIZE);
    // [wp-invariant] bytes land BEFORE any accounting advances (release pairs with the
    // decoder's acquire loads in Fifo.cpp RunGpuOnCpu/ReadDataFromFifo).
    std::atomic_thread_fence(std::memory_order_release);
    pipe_count -= GATHER_PIPE_SIZE;

    // increase the CPUWritePointer
    if (processor_interface.m_fifo_cpu_write_pointer == processor_interface.m_fifo_cpu_end)
      processor_interface.m_fifo_cpu_write_pointer = processor_interface.m_fifo_cpu_base;
    else
      processor_interface.m_fifo_cpu_write_pointer += GATHER_PIPE_SIZE;

    system.GetCommandProcessor().GatherPipeBursted();
    { volatile u32* p = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1AECu)); *p = *p + 1u; }
  }

  // move back the spill bytes
  memmove(m_gather_pipe, m_gather_pipe + processed, pipe_count);
  SetGatherPipeCount(pipe_count);
}

void GPFifoManager::FastCheckGatherPipe()
{
  if (GetGatherPipeCount() >= GATHER_PIPE_SIZE)
  {
    UpdateGatherPipe();
  }
}

void GPFifoManager::CheckGatherPipe()
{
  if (GetGatherPipeCount() >= GATHER_PIPE_SIZE)
  {
    UpdateGatherPipe();

    // Profile where slow FIFO writes are occurring.
    m_system.GetJitInterface().CompileExceptionCheck(JitInterface::ExceptionType::FIFOWrite);
  }
}

extern "C" int g_in_drain = 0;  // [domino3-src 2026-07-16] 1 while dolphin_drain_gp_ring replays the ring
// [domino3 2026-07-16] The matrix that splices into the worker's stream is a TORN GXLoadPosMtxImm:
// the worker recorded the XF header (int stores -> ring) then parked mid-command at the handover;
// dolphin's CPU ran the 12 float data stores (-> gather pipe direct, NON-drain). The data is a
// LEGITIMATE part of the frame (gpSent==ring head: the worker never issued those 12 stores), so it
// must NOT be discarded. Kept as diagnostic counters only (drain vs non-drain word source).
// [single-ordered-GX 2026-07-16] Post-takeover (cpu_owner==1) the gather pipe MUST have exactly one
// ordered writer: the worker's WPAR-store stream, materialized by dolphin_drain_gp_ring replaying
// the worker's Atomics ring (tagged g_in_drain=1 around the replay). A WPAR write that reaches
// GPFifo::Write* while cpu_owner==1 and g_in_drain==0 is dolphin's OWN thread running a guest store
// (the interpreter single-step path dolphin_interp -> SingleStepInner, taken while the worker is
// PARKED on the cmd-9 reply — so the worker is NOT producing concurrently). Letting that write land
// in the gather pipe splices the worker's mid-command stream out of order (the torn GXLoadPosMtxImm
// -> decoder desync -> SETDRAWDONE never decoded -> peFrames frozen). DROPPING it instead loses a
// legitimately-needed word (the prior discard-fix failure: fifo==ring but frozen). The correct move
// is to REDIRECT it into the SAME ring, at the head, so the very next drain replays it in program
// order relative to the worker's own words -> a single ordered stream, no tear, no loss.
//
// Ring layout (producer: ppc_worker.js gpPush; consumer: dolphin_drain_gp_ring): head @0x026C0000,
// tail @0x026C0004, 8192 slots of {u32 width, u32 val} at 0x026C0040. Safe to bump head here without
// a CAS: the worker producer is parked (blocked in mailbox_call_sync waiting for this single-step to
// return), so there is a single producer at a time. Pre-takeover (cpu_owner==0) this path is never
// entered — the guest's gather writes flow normally through Fast*/CheckGatherPipe below.
// g_in_drain is defined above (:173).
static bool gpfifo_redirect_excursion_to_ring(u32 width, u32 value)
{
  if (g_gp_discard) return true;  // boot-era seal (single-core only); swallow (unchanged legacy)
  if (*reinterpret_cast<volatile int*>(static_cast<uintptr_t>(0x026A0000u)) != 1 || g_in_drain != 0)
    return false;  // not an excursion (boot single-core, or this IS the ring replay) -> write normally
  // Excursion GX: push {width,value} into the worker's ring instead of the gather pipe.
  volatile u32* const p_head = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026C0000u));
  volatile u32* const p_tail = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026C0004u));
  const u32 h = *p_head;
  const u32 t = __atomic_load_n(const_cast<const u32*>(p_tail), __ATOMIC_ACQUIRE);
  if (((h - t) & 0xFFFFFFFFu) >= (8192u - 16u))
  {
    // Ring full (should not happen — worker is parked, drain runs every iter). Last resort: allow the
    // direct write rather than lose the word. A rare in-order-but-late byte beats a dropped command.
    return false;
  }
  const uintptr_t slot = 0x026C0040u + ((h & 8191u) * 8u);
  *reinterpret_cast<volatile u32*>(slot)      = width;
  *reinterpret_cast<volatile u32*>(slot + 4u) = value;
  __atomic_store_n(const_cast<u32*>(p_head), (h + 1u), __ATOMIC_RELEASE);
  // Diagnostic: excursion words redirected into the ring @0x026B1A50 (should track the prior
  // otherWrites=36; if peFrames now advances, the redirect closed the splice).
  {
    volatile u32* const d = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1A50u));
    *d = *d + 1u;
  }
  return true;  // handled — do NOT also write the gather pipe
}

void GPFifoManager::Write8(const u8 value)
{
  if (gpfifo_redirect_excursion_to_ring(1u, value)) return;  // [single-ordered-GX] excursion -> ring
  FastWrite8(value);
  CheckGatherPipe();
}

void GPFifoManager::Write16(const u16 value)
{
  if (gpfifo_redirect_excursion_to_ring(2u, value)) return;
  FastWrite16(value);
  CheckGatherPipe();
}

void GPFifoManager::Write32(const u32 value)
{
  // [dc-diag 2026-07-21 TEMP] Write32 entry (all calls) — is the guest's WPAR store reaching
  // dolphin's GPFifo at all? Remove after localizing the CP-FIFO break.
  { volatile u32* p = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1AE8u)); *p = *p + 1u; }
  if (gpfifo_redirect_excursion_to_ring(4u, value)) {
    return;
  }
  // [domino3-src] count drain vs NON-drain GP words + record first 24 non-drain values (diagnostic).
  // drain-count @0x026B1A48, other-count @0x026B1A4C, non-drain values @0x026B2600.
  if (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u)
  {
    if (g_in_drain) {
      volatile u32* d = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1A48u));
      *d = *d + 1u;
    } else {
      volatile u32* o = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1A4Cu));
      const u32 oi = *o;
      if (oi < 24u)
        *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2600u + oi * 4u)) = value;
      *o = oi + 1u;
    }
  }
  // [dc-diag TEMP] reached FastWrite32 (past the excursion-redirect) = write hit the gather pipe.
  { volatile u32* p = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1AF4u)); *p = *p + 1u; }
  FastWrite32(value);
  CheckGatherPipe();
}

void GPFifoManager::Write64(const u64 value)
{
  // [single-ordered-GX] A 64-bit gather write is two big-endian 32-bit words; redirect as two ring
  // slots (hi then lo) to preserve byte order in the worker's u32-slot ring. If the excursion path
  // is not active both redirect calls return false and we fall through to the normal FastWrite64.
  const u32 hi = static_cast<u32>(value >> 32);
  const u32 lo = static_cast<u32>(value & 0xFFFFFFFFu);
  // Peek once so we don't push a half word: if excursion is active, push both; else write normally.
  if (*reinterpret_cast<volatile int*>(static_cast<uintptr_t>(0x026A0000u)) == 1 && g_in_drain == 0
      && !g_gp_discard)
  {
    gpfifo_redirect_excursion_to_ring(4u, hi);
    gpfifo_redirect_excursion_to_ring(4u, lo);
    return;
  }
  if (g_gp_discard) return;  // boot-era seal
  FastWrite64(value);
  CheckGatherPipe();
}

void GPFifoManager::FastWrite8(const u8 value)
{
  auto& ppc_state = m_system.GetPPCState();
  *ppc_state.gather_pipe_ptr = value;
  ppc_state.gather_pipe_ptr += sizeof(u8);
}

void GPFifoManager::FastWrite16(u16 value)
{
  value = Common::swap16(value);
  auto& ppc_state = m_system.GetPPCState();
  std::memcpy(ppc_state.gather_pipe_ptr, &value, sizeof(u16));
  ppc_state.gather_pipe_ptr += sizeof(u16);
}

void GPFifoManager::FastWrite32(u32 value)
{
  value = Common::swap32(value);
  auto& ppc_state = m_system.GetPPCState();
  std::memcpy(ppc_state.gather_pipe_ptr, &value, sizeof(u32));
  ppc_state.gather_pipe_ptr += sizeof(u32);
}

void GPFifoManager::FastWrite64(u64 value)
{
  value = Common::swap64(value);
  auto& ppc_state = m_system.GetPPCState();
  std::memcpy(ppc_state.gather_pipe_ptr, &value, sizeof(u64));
  ppc_state.gather_pipe_ptr += sizeof(u64);
}

void UpdateGatherPipe(GPFifoManager& gpfifo)
{
  gpfifo.UpdateGatherPipe();
}

void FastCheckGatherPipe(GPFifoManager& gpfifo)
{
  gpfifo.FastCheckGatherPipe();
}
}  // namespace GPFifo
