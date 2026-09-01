// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "VideoCommon/CommandProcessor.h"

#include <atomic>
#include <fmt/format.h>

#include "Common/Assert.h"
#include "Common/ChunkFile.h"
#include "Common/CommonTypes.h"
#include "Common/Flag.h"
#include "Common/Logging/Log.h"
#include "Common/MsgHandler.h"
#include "Core/Core.h"
#include "Core/CoreTiming.h"
#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
#include <emscripten/threading.h>
// For the kEnableCell static_assert next to BemFifoBackpressure — the stage
// timers' enable cell must never land on this brake's kill switch again.
#include "VideoCommon/BemStageTimer.h"
#endif
#include "Core/HW/GPFifo.h"
#include "Core/HW/MMIO.h"
#include "Core/HW/ProcessorInterface.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"
#include "VideoCommon/Fifo.h"

namespace CommandProcessor
{
static bool IsOnThread(const Core::System& system)
{
  return system.IsDualCoreMode();
}

static void UpdateInterrupts_Wrapper(Core::System& system, u64 userdata, s64 cyclesLate)
{
  system.GetCommandProcessor().UpdateInterrupts(userdata);
}

void SCPFifoStruct::Init()
{
  CPBase = 0;
  CPEnd = 0;
  CPHiWatermark = 0;
  CPLoWatermark = 0;
  CPReadWriteDistance = 0;
  CPWritePointer = 0;
  CPReadPointer = 0;
  CPBreakpoint = 0;
  SafeCPReadPointer = 0;

  bFF_GPLinkEnable = 0;
  bFF_GPReadEnable = 0;
  bFF_BPEnable = 0;
  bFF_BPInt = 0;

  bFF_Breakpoint.store(0, std::memory_order_relaxed);
  bFF_HiWatermark.store(0, std::memory_order_relaxed);
  bFF_HiWatermarkInt.store(0, std::memory_order_relaxed);
  bFF_LoWatermark.store(0, std::memory_order_relaxed);
  bFF_LoWatermarkInt.store(0, std::memory_order_relaxed);
}

void SCPFifoStruct::DoState(PointerWrap& p)
{
  p.Do(CPBase);
  p.Do(CPEnd);
  p.Do(CPHiWatermark);
  p.Do(CPLoWatermark);
  p.Do(CPReadWriteDistance);
  p.Do(CPWritePointer);
  p.Do(CPReadPointer);
  p.Do(CPBreakpoint);
  p.Do(SafeCPReadPointer);

  p.Do(bFF_GPLinkEnable);
  p.Do(bFF_GPReadEnable);
  p.Do(bFF_BPEnable);
  p.Do(bFF_BPInt);
  p.Do(bFF_Breakpoint);

  p.Do(bFF_LoWatermarkInt);
  p.Do(bFF_HiWatermarkInt);

  p.Do(bFF_LoWatermark);
  p.Do(bFF_HiWatermark);
}

void CommandProcessorManager::DoState(PointerWrap& p)
{
  p.Do(m_cp_status_reg);
  p.Do(m_cp_ctrl_reg);
  p.Do(m_cp_clear_reg);
  p.Do(m_perf_select);
  p.Do(m_unk_0a_reg);
  m_fifo.DoState(p);

  p.Do(m_interrupt_set);
  p.Do(m_interrupt_waiting);
}

static inline void WriteLow(std::atomic<u32>& reg, u16 lowbits)
{
  reg.store((reg.load(std::memory_order_relaxed) & 0xFFFF0000) | lowbits,
            std::memory_order_relaxed);
}
static inline void WriteHigh(std::atomic<u32>& reg, u16 highbits)
{
  reg.store((reg.load(std::memory_order_relaxed) & 0x0000FFFF) | (static_cast<u32>(highbits) << 16),
            std::memory_order_relaxed);
}

CommandProcessorManager::CommandProcessorManager(Core::System& system) : m_system{system}
{
}

void CommandProcessorManager::Init()
{
  m_cp_status_reg.Hex = 0;
  m_cp_status_reg.CommandIdle = 1;
  m_cp_status_reg.ReadIdle = 1;

  m_cp_ctrl_reg.Hex = 0;

  m_cp_clear_reg.Hex = 0;

  m_fifo.Init();

  m_is_fifo_error_seen = false;

  m_interrupt_set.Clear();
  m_interrupt_waiting.Clear();

  m_event_type_update_interrupts =
      m_system.GetCoreTiming().RegisterEvent("CPInterrupt", UpdateInterrupts_Wrapper);
}

void CommandProcessorManager::RegisterMMIO(MMIO::Mapping* mmio, u32 base)
{
  constexpr u16 WMASK_LO_ALIGN_32BIT = 0xffe0;
  const u16 WMASK_HI_RESTRICT = GetPhysicalAddressMask(m_system.IsWii()) >> 16;

  struct
  {
    u32 addr;
    u16* ptr;
    // FIFO mmio regs in the range [cc000020-cc00003e] have certain bits that always read as 0
    // For _LO registers in this range, only bits 0xffe0 can be set
    // For _HI registers in this range, only bits 0x03ff can be set on GCN and 0x1fff on Wii
    u16 wmask;
  } directly_mapped_vars[] = {
      {FIFO_BASE_LO, MMIO::Utils::LowPart(&m_fifo.CPBase), WMASK_LO_ALIGN_32BIT},
      {FIFO_BASE_HI, MMIO::Utils::HighPart(&m_fifo.CPBase), WMASK_HI_RESTRICT},
      {FIFO_END_LO, MMIO::Utils::LowPart(&m_fifo.CPEnd), WMASK_LO_ALIGN_32BIT},
      {FIFO_END_HI, MMIO::Utils::HighPart(&m_fifo.CPEnd), WMASK_HI_RESTRICT},
      {FIFO_HI_WATERMARK_LO, MMIO::Utils::LowPart(&m_fifo.CPHiWatermark), WMASK_LO_ALIGN_32BIT},
      {FIFO_HI_WATERMARK_HI, MMIO::Utils::HighPart(&m_fifo.CPHiWatermark), WMASK_HI_RESTRICT},
      {FIFO_LO_WATERMARK_LO, MMIO::Utils::LowPart(&m_fifo.CPLoWatermark), WMASK_LO_ALIGN_32BIT},
      {FIFO_LO_WATERMARK_HI, MMIO::Utils::HighPart(&m_fifo.CPLoWatermark), WMASK_HI_RESTRICT},
      // FIFO_RW_DISTANCE has some complex read code different for
      // single/dual core.
      {FIFO_WRITE_POINTER_LO, MMIO::Utils::LowPart(&m_fifo.CPWritePointer), WMASK_LO_ALIGN_32BIT},
      {FIFO_WRITE_POINTER_HI, MMIO::Utils::HighPart(&m_fifo.CPWritePointer), WMASK_HI_RESTRICT},
      // FIFO_READ_POINTER has different code for single/dual core.
      {FIFO_BP_LO, MMIO::Utils::LowPart(&m_fifo.CPBreakpoint), WMASK_LO_ALIGN_32BIT},
      {FIFO_BP_HI, MMIO::Utils::HighPart(&m_fifo.CPBreakpoint), WMASK_HI_RESTRICT},
  };

  for (auto& mapped_var : directly_mapped_vars)
  {
    mmio->Register(base | mapped_var.addr, MMIO::DirectRead<u16>(mapped_var.ptr),
                   MMIO::DirectWrite<u16>(mapped_var.ptr, mapped_var.wmask));
  }

  // Timing and metrics MMIOs are stubbed with fixed values.
  struct
  {
    u32 addr;
    u16 value;
  } metrics_mmios[] = {
      {XF_RASBUSY_L, 0},
      {XF_RASBUSY_H, 0},
      {XF_CLKS_L, 0},
      {XF_CLKS_H, 0},
      {XF_WAIT_IN_L, 0},
      {XF_WAIT_IN_H, 0},
      {XF_WAIT_OUT_L, 0},
      {XF_WAIT_OUT_H, 0},
      {VCACHE_METRIC_CHECK_L, 0},
      {VCACHE_METRIC_CHECK_H, 0},
      {VCACHE_METRIC_MISS_L, 0},
      {VCACHE_METRIC_MISS_H, 0},
      {VCACHE_METRIC_STALL_L, 0},
      {VCACHE_METRIC_STALL_H, 0},
      {CLKS_PER_VTX_OUT, 4},
  };
  for (auto& metrics_mmio : metrics_mmios)
  {
    mmio->Register(base | metrics_mmio.addr, MMIO::Constant<u16>(metrics_mmio.value),
                   MMIO::InvalidWrite<u16>());
  }

  mmio->Register(base | STATUS_REGISTER, MMIO::ComplexRead<u16>([](Core::System& system_, u32) {
                   auto& cp = system_.GetCommandProcessor();
                   system_.GetFifo().SyncGPUForRegisterAccess();
                   cp.SetCpStatusRegister();
                   return cp.m_cp_status_reg.Hex;
                 }),
                 MMIO::InvalidWrite<u16>());

  mmio->Register(base | CTRL_REGISTER, MMIO::DirectRead<u16>(&m_cp_ctrl_reg.Hex),
                 MMIO::ComplexWrite<u16>([](Core::System& system_, u32, u16 val) {
                   auto& cp = system_.GetCommandProcessor();
                   // [link-diag ring 2026-07-22 TEMP] CP CTRL writes {val, guest pc} — the
                   // link/unlink timeline. head @0x026B3240, 16 entries @0x026B3250 (8B each).
                   {
                     volatile u32* const head =
                         reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3240u));
                     const u32 h = *head;
                     const uintptr_t e = 0x026B3250u + (h & 15u) * 8u;
                     *reinterpret_cast<volatile u32*>(e) = val;
                     *reinterpret_cast<volatile u32*>(e + 4u) = system_.GetPPCState().pc;
                     *head = h + 1u;
                   }
                   UCPCtrlReg tmp(val & 0x3F);
                   cp.m_cp_ctrl_reg.Hex = tmp.Hex;
                   cp.SetCpControlRegister();
                   system_.GetFifo().RunGpu();
                 }));

  mmio->Register(base | CLEAR_REGISTER, MMIO::Constant<u16>(0),
                 MMIO::ComplexWrite<u16>([](Core::System& system_, u32, u16 val) {
                   auto& cp = system_.GetCommandProcessor();
                   UCPClearReg tmp(val);
                   cp.m_cp_clear_reg.Hex = tmp.Hex;
                   cp.SetCpClearRegister();
                   system_.GetFifo().RunGpu();
                 }));

  // TODO: Figure out how this works. Written by GXSetGPMetric. Nicktoons MLB has DWARF v2 with enum
  // names.
  mmio->Register(base | PERF_SELECT, MMIO::DirectRead<u16>(&m_perf_select),
                 MMIO::DirectWrite<u16>(&m_perf_select, 0x0007));

  // TODO: Figure out what this is.
  mmio->Register(base | UNK_0A_REGISTER, MMIO::DirectRead<u16>(&m_unk_0a_reg),
                 MMIO::DirectWrite<u16>(&m_unk_0a_reg, 0x00FF));

  // Some MMIOs have different handlers for single core vs. dual core mode.
  const bool is_on_thread = IsOnThread(m_system);
  MMIO::ReadHandlingMethod<u16>* fifo_rw_distance_lo_r;
  if (is_on_thread)
  {
    fifo_rw_distance_lo_r = MMIO::ComplexRead<u16>([](Core::System& system_, u32) {
      const auto& fifo_ = system_.GetCommandProcessor().GetFifo();
      if (fifo_.CPWritePointer.load(std::memory_order_relaxed) >=
          fifo_.SafeCPReadPointer.load(std::memory_order_relaxed))
      {
        return static_cast<u16>(fifo_.CPWritePointer.load(std::memory_order_relaxed) -
                                fifo_.SafeCPReadPointer.load(std::memory_order_relaxed));
      }
      else
      {
        return static_cast<u16>(fifo_.CPEnd.load(std::memory_order_relaxed) -
                                fifo_.SafeCPReadPointer.load(std::memory_order_relaxed) +
                                fifo_.CPWritePointer.load(std::memory_order_relaxed) -
                                fifo_.CPBase.load(std::memory_order_relaxed) + 32);
      }
    });
  }
  else
  {
    fifo_rw_distance_lo_r =
        MMIO::DirectRead<u16>(MMIO::Utils::LowPart(&m_fifo.CPReadWriteDistance));
  }
  // [lo-sync 2026-07-10 — PERMANENT, the deferred-decode discard] The LO-half writes of
  // RW_DISTANCE and READ_POINTER were DirectWrite (no SyncGPUForRegisterAccess) while the
  // HI halves sync. dolsdk __GXCleanGPFifo (GXInit/GXAbortFrame) writes rp:=wp,distance:=0
  // — on real HW the GPU has already drained; with OUR deferred decode the clean landed on
  // a NON-EMPTY fifo and DISCARDED the backlog wholesale (the frame-101 draw-done token:
  // rp==wp over an intact, perfectly-framed, never-decoded stream — the armframe present-
  // stall's final layer). Decode the backlog BEFORE applying, matching the HI-half semantics.
  mmio->Register(base | FIFO_RW_DISTANCE_LO, fifo_rw_distance_lo_r,
                 MMIO::ComplexWrite<u16>([WMASK_LO_ALIGN_32BIT](Core::System& system_, u32, u16 val) {
                   auto& fifo_ = system_.GetCommandProcessor().GetFifo();
                   system_.GetFifo().SyncGPUForRegisterAccess();
                   WriteLow(fifo_.CPReadWriteDistance, val & WMASK_LO_ALIGN_32BIT);
                 }));

  MMIO::ReadHandlingMethod<u16>* fifo_rw_distance_hi_r;
  if (is_on_thread)
  {
    fifo_rw_distance_hi_r = MMIO::ComplexRead<u16>([](Core::System& system_, u32) {
      const auto& fifo_ = system_.GetCommandProcessor().GetFifo();
      system_.GetFifo().SyncGPUForRegisterAccess();
      if (fifo_.CPWritePointer.load(std::memory_order_relaxed) >=
          fifo_.SafeCPReadPointer.load(std::memory_order_relaxed))
      {
        return (fifo_.CPWritePointer.load(std::memory_order_relaxed) -
                fifo_.SafeCPReadPointer.load(std::memory_order_relaxed)) >>
               16;
      }
      else
      {
        return (fifo_.CPEnd.load(std::memory_order_relaxed) -
                fifo_.SafeCPReadPointer.load(std::memory_order_relaxed) +
                fifo_.CPWritePointer.load(std::memory_order_relaxed) -
                fifo_.CPBase.load(std::memory_order_relaxed) + 32) >>
               16;
      }
    });
  }
  else
  {
    fifo_rw_distance_hi_r = MMIO::ComplexRead<u16>([](Core::System& system_, u32) {
      const auto& fifo_ = system_.GetCommandProcessor().GetFifo();
      system_.GetFifo().SyncGPUForRegisterAccess();
      return fifo_.CPReadWriteDistance.load(std::memory_order_relaxed) >> 16;
    });
  }
  mmio->Register(base | FIFO_RW_DISTANCE_HI, fifo_rw_distance_hi_r,
                 MMIO::ComplexWrite<u16>([WMASK_HI_RESTRICT](Core::System& system_, u32, u16 val) {
                   auto& fifo_ = system_.GetCommandProcessor().GetFifo();
                   system_.GetFifo().SyncGPUForRegisterAccess();
                   WriteHigh(fifo_.CPReadWriteDistance, val & WMASK_HI_RESTRICT);
                   system_.GetFifo().RunGpu();
                 }));

  mmio->Register(
      base | FIFO_READ_POINTER_LO,
      is_on_thread ? MMIO::DirectRead<u16>(MMIO::Utils::LowPart(&m_fifo.SafeCPReadPointer)) :
                     MMIO::DirectRead<u16>(MMIO::Utils::LowPart(&m_fifo.CPReadPointer)),
      MMIO::ComplexWrite<u16>([WMASK_LO_ALIGN_32BIT](Core::System& system_, u32, u16 val) {
        auto& fifo_ = system_.GetCommandProcessor().GetFifo();
        system_.GetFifo().SyncGPUForRegisterAccess();  // [lo-sync] decode backlog before rp move
        WriteLow(fifo_.CPReadPointer, val & WMASK_LO_ALIGN_32BIT);
      }));

  MMIO::ReadHandlingMethod<u16>* fifo_read_hi_r;
  MMIO::WriteHandlingMethod<u16>* fifo_read_hi_w;
  if (is_on_thread)
  {
    fifo_read_hi_r = MMIO::ComplexRead<u16>([](Core::System& system_, u32) {
      auto& fifo_ = system_.GetCommandProcessor().GetFifo();
      system_.GetFifo().SyncGPUForRegisterAccess();
      return fifo_.SafeCPReadPointer.load(std::memory_order_relaxed) >> 16;
    });
    fifo_read_hi_w =
        MMIO::ComplexWrite<u16>([WMASK_HI_RESTRICT](Core::System& system_, u32, u16 val) {
          auto& fifo_ = system_.GetCommandProcessor().GetFifo();
          system_.GetFifo().SyncGPUForRegisterAccess();
          WriteHigh(fifo_.CPReadPointer, val & WMASK_HI_RESTRICT);
          fifo_.SafeCPReadPointer.store(fifo_.CPReadPointer.load(std::memory_order_relaxed),
                                        std::memory_order_relaxed);
        });
  }
  else
  {
    fifo_read_hi_r = MMIO::ComplexRead<u16>([](Core::System& system_, u32) {
      const auto& fifo_ = system_.GetCommandProcessor().GetFifo();
      system_.GetFifo().SyncGPUForRegisterAccess();
      return fifo_.CPReadPointer.load(std::memory_order_relaxed) >> 16;
    });
    fifo_read_hi_w =
        MMIO::ComplexWrite<u16>([WMASK_HI_RESTRICT](Core::System& system_, u32, u16 val) {
          auto& fifo_ = system_.GetCommandProcessor().GetFifo();
          system_.GetFifo().SyncGPUForRegisterAccess();
          WriteHigh(fifo_.CPReadPointer, val & WMASK_HI_RESTRICT);
        });
  }
  mmio->Register(base | FIFO_READ_POINTER_HI, fifo_read_hi_r, fifo_read_hi_w);
}

#if defined(__EMSCRIPTEN__)
// [fifo-backpressure 2026-08-29] HOST-SIDE GXOverflowHandler.
//
// WHY: on real hardware the guest's ONLY brake on the CP FIFO is the overflow
// interrupt. GXSetCPUFifo arms it (~/gc_refs/dolsdk2001/src/gx/GXFifo.c:169
// __GXWriteFifoIntEnable(1,0)), GXCPInterruptHandler (:84-94) dispatches
// GXOverflowHandler, and that handler is literally
// OSSuspendThread(__GXCurrentThread) (:31-51) — the CPU STOPS WRITING until the
// GP drains past the low watermark. GXInitFifoBase leaves only
// hiWatermark = size - 0x4000 (:112), i.e. 16 KB / 512 bursts, of slack.
//
// THIS BUILD HIDES CP FROM THE GUEST: the guest's read of PI cause 0xCC003000
// masks out 0x800 (dolphin_jit_wimports.cpp:338-341) and dolphin_check_exc
// deasserts it host-side and never defers on it (:530-535). So
// GXOverflowHandler NEVER RUNS. There is also no host-side substitute:
// MAIN_SYNC_GPU defaults false (Core/Config/MainSettings.cpp:220) and
// Boot.cpp:445-452 records it as measured and deliberately OFF. Dolphin's own
// overflow check is the ASSERT_MSG below — a message, not a brake.
// Result: the guest can write past the read pointer, the decoder picks the
// stream up mid-command ("GFX FIFO: Unknown Opcode"), and once the spliced
// command is a SETDRAWDONE the PE FINISH never fires, so GXWaitDrawDone
// (GXMisc.c, DrawDone at r13-0x3530) spins forever at xpc=0x80375364.
//
// THIS IS NOT MAIN_SYNC_GPU: there is no per-pump tick throttle and no cost at
// all while the FIFO is healthy — it engages only past the guest's own high
// watermark, which is where hardware suspends the thread.
//
// WE CANNOT DRAIN INLINE HERE. The decoder's consumer is the proxied-main pump
// (Main.cpp:463 RunGpuLoopSlice) because that thread owns the WebGPU device;
// Core.cpp:548-549 records that wgpu calls on a device-less thread NEVER RETURN.
// So this parks the producer and lets the real consumer catch up, which is the
// same observable as OSSuspendThread.
//
// DEADLOCK HAZARD, handled: the consumer's drain loop refuses to run while a CP
// interrupt is waiting (Fifo.cpp:397 `while (!IsInterruptWaiting() && ...)`),
// and crossing the high watermark is exactly what raises it
// (SetCPStatusFromGPU, this file: ovfInt -> m_interrupt_waiting.Set()). The
// CoreTiming event that CLEARS m_interrupt_waiting runs on the CPU thread — the
// thread we are about to park. So parking without servicing it deadlocks both
// sides. We service it inline; we ARE the CPU thread, which is where
// UpdateInterrupts is meant to run, and the still-scheduled event repeating it
// later is idempotent.
//
// BOUNDED: on timeout we give up and let the burst through, so the worst case
// degrades to today's behaviour rather than to a new hang.
//
// Witness cells (0x026B3B10..0x026B3B20 — the "no other use" claim below WAS
// FALSE from 2026-08-29 to 2026-09-01: BemStageTimer::kEnableCell was placed on
// 0x026B3B20 and silently disabled this brake; the static_assert below now
// enforces it;
// 0x026B3B00/04/08 are the draw-ablation arms):
//   0x026B3B10 engage count   0x026B3B14 timeout-bail count
//   0x026B3B18 cumulative ms parked      0x026B3B1C max distance seen at engage
//   0x026B3B20 KILL SWITCH (nonzero = brake DISABLED, for a matched-pair control
//              on ONE wasm)
// [CELL COLLISION GUARD 2026-09-01] BemStageTimer's `enable` cell was placed on
// 0x026B3B20 — this brake's KILL SWITCH — so arming the render-stage timers
// (probe: PROBE_STAGE_SPLIT) silently DISABLED the wedge brake. Naming the
// address and asserting it against the timer's cell makes a repeat a build
// error instead of a silent loss of the only backpressure the guest has.
inline constexpr uintptr_t kBemFifoBrakeKillCell = 0x026B3B20u;
static_assert(kBemFifoBrakeKillCell != BemStage::kEnableCell,
              "FIFO-brake kill switch collides with BemStageTimer::kEnableCell — "
              "arming the stage timers would disable the PSO FIFO wedge brake");

void CommandProcessorManager::BemFifoBackpressure()
{
  if (*reinterpret_cast<volatile u32*>(kBemFifoBrakeKillCell) != 0u)
    return;  // control arm: brake off

  const u32 hi = m_fifo.CPHiWatermark;
  if (hi == 0u)
    return;  // guest has not programmed a watermark yet

  const u32 dist = m_fifo.CPReadWriteDistance.load(std::memory_order_seq_cst);
  if (dist <= hi)
    return;  // FIFO healthy — this is the whole cost in the common case

  // Only the CPU thread may park here. GatherPipeBursted is also reachable from
  // the pump/state paths, and parking the device thread would stop the very
  // consumer we are waiting on.
  if (!IsOnThread(m_system) || m_system.GetFifo().UseDeterministicGPUThread() ||
      !Core::IsCPUThread())
    return;

  volatile u32* const c_engage = reinterpret_cast<volatile u32*>(uintptr_t(0x026B3B10u));
  volatile u32* const c_bail = reinterpret_cast<volatile u32*>(uintptr_t(0x026B3B14u));
  volatile u32* const c_ms = reinterpret_cast<volatile u32*>(uintptr_t(0x026B3B18u));
  volatile u32* const c_max = reinterpret_cast<volatile u32*>(uintptr_t(0x026B3B1Cu));
  *c_engage = *c_engage + 1u;
  if (dist > *c_max)
    *c_max = dist;

  // Drain target: the guest's own low watermark when it set one (that is what
  // GXOverflowHandler waits for via the underflow interrupt), else back under
  // the high watermark.
  const u32 lo = m_fifo.CPLoWatermark;
  const u32 target = (lo != 0u && lo < hi) ? lo : hi;

  const double t0 = emscripten_get_now();
  while (m_fifo.CPReadWriteDistance.load(std::memory_order_seq_cst) > target &&
         m_fifo.bFF_GPReadEnable.load(std::memory_order_relaxed) != 0)
  {
    if (m_interrupt_waiting.IsSet())
    {
      // Reopen the consumer's gate (see DEADLOCK HAZARD above).
      UpdateInterrupts(m_fifo.bFF_HiWatermark.load(std::memory_order_relaxed) ? 1 : 0);
    }
    m_system.GetFifo().RunGpu();
    if ((emscripten_get_now() - t0) > 500.0)
    {
      *c_bail = *c_bail + 1u;
      break;
    }
    emscripten_thread_sleep(0.2);
  }
  *c_ms = *c_ms + static_cast<u32>(emscripten_get_now() - t0);
}
#endif

void CommandProcessorManager::GatherPipeBursted()
{
  SetCPStatusFromCPU();

  auto& processor_interface = m_system.GetProcessorInterface();

  const bool _dc_owner =
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u;
  // if we aren't linked, we don't care about gather pipe data
  if (!m_cp_ctrl_reg.GPLinkEnable)
  {
    if (IsOnThread(m_system) && !m_system.GetFifo().UseDeterministicGPUThread())
    {
      // In multibuffer mode is not allowed write in the same FIFO attached to the GPU.
      // Fix Pokemon XD in DC mode.
      if ((processor_interface.m_fifo_cpu_end == m_fifo.CPEnd.load(std::memory_order_relaxed)) &&
          (processor_interface.m_fifo_cpu_base == m_fifo.CPBase.load(std::memory_order_relaxed)) &&
          m_fifo.CPReadWriteDistance.load(std::memory_order_relaxed) > 0)
      {
        m_system.GetFifo().FlushGpu();
      }
    }
    m_system.GetFifo().RunGpu();
    return;
  }

  // update the fifo pointer
  if (m_fifo.CPWritePointer.load(std::memory_order_relaxed) ==
      m_fifo.CPEnd.load(std::memory_order_relaxed))
  {
    m_fifo.CPWritePointer.store(m_fifo.CPBase, std::memory_order_relaxed);
  }
  else
  {
    m_fifo.CPWritePointer.fetch_add(GPFifo::GATHER_PIPE_SIZE, std::memory_order_relaxed);
  }

  if (m_cp_ctrl_reg.GPReadEnable && m_cp_ctrl_reg.GPLinkEnable)
  {
    processor_interface.m_fifo_cpu_write_pointer =
        m_fifo.CPWritePointer.load(std::memory_order_relaxed);
    processor_interface.m_fifo_cpu_base = m_fifo.CPBase.load(std::memory_order_relaxed);
    processor_interface.m_fifo_cpu_end = m_fifo.CPEnd.load(std::memory_order_relaxed);
  }

  // If the game is running close to overflowing, make the exception checking more frequent.
  if (m_fifo.bFF_HiWatermark.load(std::memory_order_relaxed) != 0)
    m_system.GetCoreTiming().ForceExceptionCheck(0);

  m_fifo.CPReadWriteDistance.fetch_add(GPFifo::GATHER_PIPE_SIZE, std::memory_order_seq_cst);
  // [dist/seq-diag STRIPPED 2026-07-22 — served PM11/PM12; per-burst publish cost removed.]

  m_system.GetFifo().RunGpu();

#if defined(__EMSCRIPTEN__)
  BemFifoBackpressure();
#endif

  ASSERT_MSG(COMMANDPROCESSOR,
             m_fifo.CPReadWriteDistance.load(std::memory_order_relaxed) <=
                 m_fifo.CPEnd.load(std::memory_order_relaxed) -
                     m_fifo.CPBase.load(std::memory_order_relaxed),
             "FIFO is overflowed by GatherPipe !\nCPU thread is too fast!");

  // check if we are in sync
  ASSERT_MSG(COMMANDPROCESSOR,
             m_fifo.CPWritePointer.load(std::memory_order_relaxed) ==
                 processor_interface.m_fifo_cpu_write_pointer,
             "FIFOs linked but out of sync");
  ASSERT_MSG(COMMANDPROCESSOR,
             m_fifo.CPBase.load(std::memory_order_relaxed) == processor_interface.m_fifo_cpu_base,
             "FIFOs linked but out of sync");
  ASSERT_MSG(COMMANDPROCESSOR,
             m_fifo.CPEnd.load(std::memory_order_relaxed) == processor_interface.m_fifo_cpu_end,
             "FIFOs linked but out of sync");
}

void CommandProcessorManager::UpdateInterrupts(u64 userdata)
{
  if (userdata)
  {
    m_interrupt_set.Set();
    DEBUG_LOG_FMT(COMMANDPROCESSOR, "Interrupt set");
    m_system.GetProcessorInterface().SetInterrupt(INT_CAUSE_CP, true);
  }
  else
  {
    m_interrupt_set.Clear();
    DEBUG_LOG_FMT(COMMANDPROCESSOR, "Interrupt cleared");
    m_system.GetProcessorInterface().SetInterrupt(INT_CAUSE_CP, false);
  }
  m_system.GetCoreTiming().ForceExceptionCheck(0);
  m_interrupt_waiting.Clear();
  m_system.GetFifo().RunGpu();
}

void CommandProcessorManager::UpdateInterruptsFromVideoBackend(u64 userdata)
{
  if (!m_system.GetFifo().UseDeterministicGPUThread())
  {
    m_system.GetCoreTiming().ScheduleEvent(0, m_event_type_update_interrupts, userdata,
                                           CoreTiming::FromThread::NON_CPU);
  }
}

bool CommandProcessorManager::IsInterruptWaiting() const
{
  return m_interrupt_waiting.IsSet();
}

void CommandProcessorManager::SetCPStatusFromGPU()
{
  // breakpoint
  const bool breakpoint = m_fifo.bFF_Breakpoint.load(std::memory_order_relaxed);
  if (m_fifo.bFF_BPEnable.load(std::memory_order_relaxed) != 0)
  {
    if (m_fifo.CPBreakpoint.load(std::memory_order_relaxed) ==
        m_fifo.CPReadPointer.load(std::memory_order_relaxed))
    {
      if (!breakpoint)
      {
        DEBUG_LOG_FMT(COMMANDPROCESSOR, "Hit breakpoint at {}",
                      m_fifo.CPReadPointer.load(std::memory_order_relaxed));
        m_fifo.bFF_Breakpoint.store(1, std::memory_order_relaxed);
      }
    }
    else
    {
      if (breakpoint)
      {
        DEBUG_LOG_FMT(COMMANDPROCESSOR, "Cleared breakpoint at {}",
                      m_fifo.CPReadPointer.load(std::memory_order_relaxed));
        m_fifo.bFF_Breakpoint.store(0, std::memory_order_relaxed);
      }
    }
  }
  else
  {
    if (breakpoint)
    {
      DEBUG_LOG_FMT(COMMANDPROCESSOR, "Cleared breakpoint at {}",
                    m_fifo.CPReadPointer.load(std::memory_order_relaxed));
      m_fifo.bFF_Breakpoint = false;
    }
  }

  // overflow & underflow check
  m_fifo.bFF_HiWatermark.store(
      (m_fifo.CPReadWriteDistance.load(std::memory_order_relaxed) > m_fifo.CPHiWatermark),
      std::memory_order_relaxed);
  m_fifo.bFF_LoWatermark.store(
      (m_fifo.CPReadWriteDistance.load(std::memory_order_relaxed) < m_fifo.CPLoWatermark),
      std::memory_order_relaxed);

  bool bpInt = m_fifo.bFF_Breakpoint.load(std::memory_order_relaxed) &&
               m_fifo.bFF_BPInt.load(std::memory_order_relaxed);
  bool ovfInt = m_fifo.bFF_HiWatermark.load(std::memory_order_relaxed) &&
                m_fifo.bFF_HiWatermarkInt.load(std::memory_order_relaxed);
  bool undfInt = m_fifo.bFF_LoWatermark.load(std::memory_order_relaxed) &&
                 m_fifo.bFF_LoWatermarkInt.load(std::memory_order_relaxed);

  bool interrupt = (bpInt || ovfInt || undfInt) && m_cp_ctrl_reg.GPReadEnable;

  if (interrupt != m_interrupt_set.IsSet() && !m_interrupt_waiting.IsSet())
  {
    const u64 userdata = interrupt ? 1 : 0;
    if (IsOnThread(m_system))
    {
      if (!interrupt || bpInt || undfInt || ovfInt)
      {
        // Schedule the interrupt asynchronously
        m_interrupt_waiting.Set();
        UpdateInterruptsFromVideoBackend(userdata);
      }
    }
    else
    {
      UpdateInterrupts(userdata);
    }
  }
}

void CommandProcessorManager::SetCPStatusFromCPU()
{
  // overflow & underflow check
  m_fifo.bFF_HiWatermark.store(
      (m_fifo.CPReadWriteDistance.load(std::memory_order_relaxed) > m_fifo.CPHiWatermark),
      std::memory_order_relaxed);
  m_fifo.bFF_LoWatermark.store(
      (m_fifo.CPReadWriteDistance.load(std::memory_order_relaxed) < m_fifo.CPLoWatermark),
      std::memory_order_relaxed);

  bool bpInt = m_fifo.bFF_Breakpoint.load(std::memory_order_relaxed) &&
               m_fifo.bFF_BPInt.load(std::memory_order_relaxed);
  bool ovfInt = m_fifo.bFF_HiWatermark.load(std::memory_order_relaxed) &&
                m_fifo.bFF_HiWatermarkInt.load(std::memory_order_relaxed);
  bool undfInt = m_fifo.bFF_LoWatermark.load(std::memory_order_relaxed) &&
                 m_fifo.bFF_LoWatermarkInt.load(std::memory_order_relaxed);

  bool interrupt = (bpInt || ovfInt || undfInt) && m_cp_ctrl_reg.GPReadEnable;

  if (interrupt != m_interrupt_set.IsSet() && !m_interrupt_waiting.IsSet())
  {
    const u64 userdata = interrupt ? 1 : 0;
    if (IsOnThread(m_system))
    {
      if (!interrupt || bpInt || undfInt || ovfInt)
      {
        m_interrupt_set.Set(interrupt);
        DEBUG_LOG_FMT(COMMANDPROCESSOR, "Interrupt set");
        m_system.GetProcessorInterface().SetInterrupt(INT_CAUSE_CP, interrupt);
      }
    }
    else
    {
      UpdateInterrupts(userdata);
    }
  }
}

void CommandProcessorManager::SetCpStatusRegister()
{
  // Here always there is one fifo attached to the GPU
  m_cp_status_reg.Breakpoint = m_fifo.bFF_Breakpoint.load(std::memory_order_relaxed);
  m_cp_status_reg.ReadIdle = !m_fifo.CPReadWriteDistance.load(std::memory_order_relaxed) ||
                             (m_fifo.CPReadPointer.load(std::memory_order_relaxed) ==
                              m_fifo.CPWritePointer.load(std::memory_order_relaxed));
  m_cp_status_reg.CommandIdle = !m_fifo.CPReadWriteDistance.load(std::memory_order_relaxed) ||
                                Fifo::AtBreakpoint(m_system) ||
                                !m_fifo.bFF_GPReadEnable.load(std::memory_order_relaxed);
  m_cp_status_reg.UnderflowLoWatermark = m_fifo.bFF_LoWatermark.load(std::memory_order_relaxed);
  m_cp_status_reg.OverflowHiWatermark = m_fifo.bFF_HiWatermark.load(std::memory_order_relaxed);

  DEBUG_LOG_FMT(COMMANDPROCESSOR, "\t Read from STATUS_REGISTER : {:04x}", m_cp_status_reg.Hex);
  DEBUG_LOG_FMT(COMMANDPROCESSOR,
                "(r) status: iBP {} | fReadIdle {} | fCmdIdle {} | iOvF {} | iUndF {}",
                m_cp_status_reg.Breakpoint ? "ON" : "OFF", m_cp_status_reg.ReadIdle ? "ON" : "OFF",
                m_cp_status_reg.CommandIdle ? "ON" : "OFF",
                m_cp_status_reg.OverflowHiWatermark ? "ON" : "OFF",
                m_cp_status_reg.UnderflowLoWatermark ? "ON" : "OFF");
}

void CommandProcessorManager::SetCpControlRegister()
{
  // Just before disabling reads, give the GPU a chance to catch up.
  if (m_fifo.bFF_GPReadEnable.load(std::memory_order_relaxed) && !m_cp_ctrl_reg.GPReadEnable)
  {
    m_system.GetFifo().SyncGPUForRegisterAccess();
  }
  m_fifo.bFF_GPReadEnable.store(m_cp_ctrl_reg.GPReadEnable, std::memory_order_relaxed);
  m_fifo.bFF_BPInt.store(m_cp_ctrl_reg.BPInt, std::memory_order_relaxed);
  m_fifo.bFF_BPEnable.store(m_cp_ctrl_reg.BPEnable, std::memory_order_relaxed);
  m_fifo.bFF_HiWatermarkInt.store(m_cp_ctrl_reg.FifoOverflowIntEnable, std::memory_order_relaxed);
  m_fifo.bFF_LoWatermarkInt.store(m_cp_ctrl_reg.FifoUnderflowIntEnable, std::memory_order_relaxed);
  m_fifo.bFF_GPLinkEnable.store(m_cp_ctrl_reg.GPLinkEnable, std::memory_order_relaxed);

  DEBUG_LOG_FMT(COMMANDPROCESSOR, "\t GPREAD {} | BP {} | Int {} | OvF {} | UndF {} | LINK {}",
                m_fifo.bFF_GPReadEnable.load(std::memory_order_relaxed) ? "ON" : "OFF",
                m_fifo.bFF_BPEnable.load(std::memory_order_relaxed) ? "ON" : "OFF",
                m_fifo.bFF_BPInt.load(std::memory_order_relaxed) ? "ON" : "OFF",
                m_cp_ctrl_reg.FifoOverflowIntEnable ? "ON" : "OFF",
                m_cp_ctrl_reg.FifoUnderflowIntEnable ? "ON" : "OFF",
                m_cp_ctrl_reg.GPLinkEnable ? "ON" : "OFF");
}

// NOTE: We intentionally don't emulate this function at the moment.
// We don't emulate proper GP timing anyway at the moment, so it would just slow down emulation.
void CommandProcessorManager::SetCpClearRegister()
{
}

void CommandProcessorManager::ResetFifo()
{
  // Link fifos, disable interrupts, disable reads.
  m_cp_ctrl_reg.Hex = 0x0010;
  SetCpControlRegister();
  m_perf_select = 0;
  m_unk_0a_reg = 0;
  m_fifo.CPLoWatermark = 0;
  m_fifo.CPHiWatermark = GetPhysicalAddressMask(m_system.IsWii()) & ~31u;
  SetCpStatusRegister();
}

void CommandProcessorManager::HandleUnknownOpcode(u8 cmd_byte, const u8* buffer, bool preprocess)
{
  // Datel software uses 0x01 during startup, and Mario Party 5's Wiggler capsule accidentally uses
  // 0x01-0x03 due to sending 4 more vertices than intended (see https://dolp.in/i8104).
  // Prince of Persia: Rival Swords sends 0x3f if the home menu is opened during the intro cutscene
  // due to a game bug resulting in an incorrect vertex desc that results in the float value 1.0,
  // encoded as 0x3f800000, being parsed as an opcode (see https://dolp.in/i9203).
  //
  // Hardware testing indicates that these opcodes do nothing, so to avoid annoying the user with
  // spurious popups, we don't create a panic alert in those cases.  Other unknown opcodes
  // (such as 0x18) seem to result in actual hangs on real hardware, so the alert still is important
  // to keep around for unexpected cases.
  const bool suppress_panic_alert = (cmd_byte <= 0x7) || (cmd_byte == 0x3f);

  const auto log_level =
      suppress_panic_alert ? Common::Log::LogLevel::LWARNING : Common::Log::LogLevel::LERROR;

  // We always generate this log message, though we only generate the panic alerts once.
  //
  // PC and LR are generally inaccurate in dual-core and are still misleading in single-core
  // due to the gather pipe queueing data.  Changing GATHER_PIPE_SIZE to 1 and
  // GATHER_PIPE_EXTRA_SIZE to 16 * 32 in GPFifo.h, and using the cached interpreter CPU emulation
  // engine, can result in more accurate information (though it is still a bit delayed).
  // PC and LR are meaningless when using the fifoplayer, and will generally not be helpful if the
  // unknown opcode is inside of a display list.  Also note that the changes in GPFifo.h are not
  // accurate and may introduce timing issues.
  const auto& ppc_state = m_system.GetPPCState();
  GENERIC_LOG_FMT(
      Common::Log::LogType::VIDEO, log_level,
      "FIFO: Unknown Opcode {:#04x} @ {}, preprocessing = {}, CPBase: {:#010x}, CPEnd: "
      "{:#010x}, CPHiWatermark: {:#010x}, CPLoWatermark: {:#010x}, CPReadWriteDistance: "
      "{:#010x}, CPWritePointer: {:#010x}, CPReadPointer: {:#010x}, CPBreakpoint: "
      "{:#010x}, bFF_GPReadEnable: {}, bFF_BPEnable: {}, bFF_BPInt: {}, bFF_Breakpoint: "
      "{}, bFF_GPLinkEnable: {}, bFF_HiWatermarkInt: {}, bFF_LoWatermarkInt: {}, "
      "approximate PC: {:08x}, approximate LR: {:08x}",
      cmd_byte, fmt::ptr(buffer), preprocess ? "yes" : "no",
      m_fifo.CPBase.load(std::memory_order_relaxed), m_fifo.CPEnd.load(std::memory_order_relaxed),
      m_fifo.CPHiWatermark, m_fifo.CPLoWatermark,
      m_fifo.CPReadWriteDistance.load(std::memory_order_relaxed),
      m_fifo.CPWritePointer.load(std::memory_order_relaxed),
      m_fifo.CPReadPointer.load(std::memory_order_relaxed),
      m_fifo.CPBreakpoint.load(std::memory_order_relaxed),
      m_fifo.bFF_GPReadEnable.load(std::memory_order_relaxed) ? "true" : "false",
      m_fifo.bFF_BPEnable.load(std::memory_order_relaxed) ? "true" : "false",
      m_fifo.bFF_BPInt.load(std::memory_order_relaxed) ? "true" : "false",
      m_fifo.bFF_Breakpoint.load(std::memory_order_relaxed) ? "true" : "false",
      m_fifo.bFF_GPLinkEnable.load(std::memory_order_relaxed) ? "true" : "false",
      m_fifo.bFF_HiWatermarkInt.load(std::memory_order_relaxed) ? "true" : "false",
      m_fifo.bFF_LoWatermarkInt.load(std::memory_order_relaxed) ? "true" : "false", ppc_state.pc,
      LR(ppc_state));

  if (!m_is_fifo_error_seen && !suppress_panic_alert)
  {
    m_is_fifo_error_seen = true;

    // The panic alert contains an explanatory part that's worded differently depending on the
    // user's settings, so as to offer the most relevant advice to the user.
    const char* advice;
    if (IsOnThread(m_system) && !m_system.GetFifo().UseDeterministicGPUThread())
    {
      if (!m_system.GetCoreTiming().UseSyncOnSkipIdle() && !m_system.GetFifo().UseSyncGPU())
      {
// The SyncOnSkipIdle setting is only in the Android GUI, so we use the INI name on other platforms.
//
// TODO: Mark the Android string as translatable once we have translations on Android. It's
// currently untranslatable so translators won't try to look up how they translated "Synchronize
// GPU Thread" and "On Idle Skipping" and then not find those strings and become confused.
#ifdef ANDROID
        advice = "Please change the \"Synchronize GPU Thread\" setting to \"On Idle Skipping\"! "
                 "It's currently set to \"Never\", which makes this problem very likely to happen.";
#else
        // i18n: Please leave SyncOnSkipIdle and True untranslated.
        // The user needs to enter these terms as-is in an INI file.
        advice = _trans("Please change the \"SyncOnSkipIdle\" setting to \"True\"! "
                        "It's currently disabled, which makes this problem very likely to happen.");
#endif
      }
      else
      {
        advice = _trans(
            "This error is usually caused by the emulated GPU desyncing with the emulated CPU. "
            "Turn off the \"Dual Core\" setting to avoid this.");
      }
    }
    else
    {
      advice = _trans(
          "This error is usually caused by the emulated GPU desyncing with the emulated CPU, "
          "but your current settings make this unlikely to happen. If this error is stopping the "
          "game from working, please report it to the developers.");
    }

    PanicAlertFmtT("GFX FIFO: Unknown Opcode ({0:#04x} @ {1}, preprocess={2}).\n"
                   "\n"
                   "{3}\n"
                   "\n"
                   "Further errors will be sent to the Video Backend log and "
                   "Dolphin will now likely crash or hang.",
                   cmd_byte, fmt::ptr(buffer), preprocess, Common::GetStringT(advice));
  }
}

}  // namespace CommandProcessor
