// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "Core/HW/ProcessorInterface.h"

#include <memory>

#include "Common/Assert.h"
#include "Common/ChunkFile.h"
#include "Common/CommonTypes.h"
#include "Common/Logging/Log.h"
#include "Core/Core.h"
#include "Core/CoreTiming.h"
#include "Core/HW/DVD/DVDInterface.h"
#include "Core/HW/MMIO.h"
#include "Core/HW/SystemTimers.h"
#include "Core/IOS/IOS.h"
#include "Core/IOS/STM/STM.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"
#include "VideoCommon/AsyncRequests.h"
#include "VideoCommon/CommandProcessor.h"
#include "VideoCommon/Fifo.h"

namespace ProcessorInterface
{
constexpr u32 FLIPPER_REV_A [[maybe_unused]] = 0x046500B0;
constexpr u32 FLIPPER_REV_B [[maybe_unused]] = 0x146500B1;
constexpr u32 FLIPPER_REV_C = 0x246500B1;

ProcessorInterfaceManager::ProcessorInterfaceManager(Core::System& system) : m_system(system)
{
}

ProcessorInterfaceManager::~ProcessorInterfaceManager() = default;

void ProcessorInterfaceManager::DoState(PointerWrap& p)
{
  p.Do(m_interrupt_mask);
  p.Do(m_interrupt_cause);
  p.Do(m_fifo_cpu_base);
  p.Do(m_fifo_cpu_end);
  p.Do(m_fifo_cpu_write_pointer);
  p.Do(m_reset_code);
}

void ProcessorInterfaceManager::Init()
{
  m_interrupt_mask = 0;
  m_interrupt_cause = 0;

  m_fifo_cpu_base = 0;
  m_fifo_cpu_end = 0;
  m_fifo_cpu_write_pointer = 0;

  m_reset_code = 0;  // Cold reset
  m_interrupt_cause = INT_CAUSE_RST_BUTTON | INT_CAUSE_VI;

  auto& core_timing = m_system.GetCoreTiming();
  m_event_type_toggle_reset_button =
      core_timing.RegisterEvent("ToggleResetButton", ToggleResetButtonCallback);
  m_event_type_ios_notify_reset_button =
      core_timing.RegisterEvent("IOSNotifyResetButton", IOSNotifyResetButtonCallback);
  m_event_type_ios_notify_power_button =
      core_timing.RegisterEvent("IOSNotifyPowerButton", IOSNotifyPowerButtonCallback);
}

void ProcessorInterfaceManager::RegisterMMIO(MMIO::Mapping* mmio, u32 base)
{
  mmio->Register(base | PI_INTERRUPT_CAUSE, MMIO::DirectRead<u32>(&m_interrupt_cause),
                 MMIO::ComplexWrite<u32>([](Core::System& system, u32, u32 val) {
                   auto& processor_interface = system.GetProcessorInterface();
                   processor_interface.m_interrupt_cause &= ~val;
                   processor_interface.UpdateException();
                 }));

  mmio->Register(base | PI_INTERRUPT_MASK, MMIO::DirectRead<u32>(&m_interrupt_mask),
                 MMIO::ComplexWrite<u32>([](Core::System& system, u32, u32 val) {
                   auto& processor_interface = system.GetProcessorInterface();
                   processor_interface.m_interrupt_mask = val;
                   processor_interface.UpdateException();
                 }));

  mmio->Register(base | PI_FIFO_BASE, MMIO::DirectRead<u32>(&m_fifo_cpu_base),
                 MMIO::DirectWrite<u32>(&m_fifo_cpu_base, 0xFFFFFFE0));

  mmio->Register(base | PI_FIFO_END, MMIO::DirectRead<u32>(&m_fifo_cpu_end),
                 MMIO::DirectWrite<u32>(&m_fifo_cpu_end, 0xFFFFFFE0));

  mmio->Register(base | PI_FIFO_WPTR, MMIO::DirectRead<u32>(&m_fifo_cpu_write_pointer),
                 MMIO::DirectWrite<u32>(&m_fifo_cpu_write_pointer, 0xFFFFFFE0));

  mmio->Register(base | PI_FIFO_RESET, MMIO::InvalidRead<u32>(),
                 MMIO::ComplexWrite<u32>([](Core::System& system, u32, u32 val) {
                   // Used by GXAbortFrame
                   INFO_LOG_FMT(PROCESSORINTERFACE, "Wrote PI_FIFO_RESET: {:08x}", val);
                   if ((val & 1) != 0)
                   {
                     // TODO: Is this still necessary now that we reset the CP registers?
                     system.GetGPFifo().ResetGatherPipe();

                     // Reset some CP registers. This may trigger an ad-hoc GPU time slice.
                     system.GetCommandProcessor().ResetFifo();

                     // Call Fifo::ResetVideoBuffer() from the video thread. Since that function
                     // resets various pointers used by the video thread, we can't call it directly
                     // from the CPU thread, so queue a task to do it instead. In single-core mode,
                     // AsyncRequests is in passthrough mode, so this will be safely and immediately
                     // called on the CPU thread.

                     // NOTE: GPFifo::ResetGatherPipe() only affects
                     // CPU state, so we can call it directly

                     AsyncRequests::GetInstance()->PushEvent(
                         [] { Core::System::GetInstance().GetFifo().ResetVideoBuffer(); });
                   }
                 }));

  mmio->Register(base | PI_RESET_CODE, MMIO::ComplexRead<u32>([](Core::System& system, u32) {
                   auto& processor_interface = system.GetProcessorInterface();
                   DEBUG_LOG_FMT(PROCESSORINTERFACE, "Read PI_RESET_CODE: {:08x}",
                                 processor_interface.m_reset_code);
                   return processor_interface.m_reset_code;
                 }),
                 MMIO::ComplexWrite<u32>([](Core::System& system, u32, u32 val) {
                   auto& processor_interface = system.GetProcessorInterface();
                   processor_interface.m_reset_code = val;
                   INFO_LOG_FMT(PROCESSORINTERFACE, "Wrote PI_RESET_CODE: {:08x}",
                                processor_interface.m_reset_code);
                   if (!system.IsWii() && (~processor_interface.m_reset_code & 0x4))
                   {
                     system.GetDVDInterface().ResetDrive(true);
                   }
                 }));

  mmio->Register(base | PI_FLIPPER_REV, MMIO::Constant<u32>(FLIPPER_REV_C),
                 MMIO::InvalidWrite<u32>());

  // 16 bit reads are based on 32 bit reads.
  for (u32 i = 0; i < 0x1000; i += 4)
  {
    mmio->Register(base | i, MMIO::ReadToLarger<u16>(mmio, base | i, 16),
                   MMIO::InvalidWrite<u16>());
    mmio->Register(base | (i + 2), MMIO::ReadToLarger<u16>(mmio, base | i, 0),
                   MMIO::InvalidWrite<u16>());
  }
}

// [dual-core DSP/AI mask STICKY 2026-06-30] Sticky "the ppc-worker has engaged" flag. Once Phase IV
// has ever been set (handover done), DSP/AI stay masked from dolphin's EXTERNAL_INT view even while
// Phase IV is momentarily CLEAR during the ISR excursion. Without this, the excursion's
// __OSDispatchInterrupt reads an unmasked DSP cause (no registered handler) -> null handler -> PC=0
// ISI -> PPCHalt. Shared with dolphin_read32 (dolphin_jit_wimports.cpp) which masks the cause read.
extern "C" int g_dc_handover_done = 0;

void ProcessorInterfaceManager::UpdateException()
{
  auto& ppc_state = m_system.GetPPCState();
  // [dual-core DSP/AI mask 2026-06-29] Native PERMANENTLY masks the DSP/AI interrupts
  // (OSInterrupt 5-7; OS mask bits 0x07800000 always set) — its DSP HLE services them out of
  // band and clears them. Our DSP HLE is disabled (JitWasm.cpp:3227), so the guest OS mask
  // leaves DSP/AI UNMASKED while they are never cleared, and __OSDispatchInterrupt overruns its
  // unbounded for(;;++prio) loop on the unhandled DSP cause (verified via the native oracle:
  // worker c4=0xf07f8360 vs native 0xF7FF8360 at the same context). Hide INT_CAUSE_DSP(0x40)+
  // INT_CAUSE_AI(0x20) from the EXTERNAL_INT the dual-core worker sees so it only takes
  // interrupts it can dispatch (VI etc.), matching native's effective behavior. The DSP/AI bits
  // stay pending in m_interrupt_cause (unserviced — no audio yet) but never wedge dispatch.
  // Only hide DSP/AI once the dual-core worker is DRIVING the CPU (SAB CT_PHASE_FLAGS bit 1 =
  // CT_PHASE4_ENABLE at 0x0268002C, set at handover). During single-core boot dolphin's own CPU
  // must still take DSP/AI or the guest OS audio init wedges (observed: boot stuck pre-handover at
  // pc=0x800b66e8 when this masked unconditionally). After handover the worker drives and dolphin
  // only advances devices, so masking its EXTERNAL_INT view is safe and matches native.
  // [dsp-unhide A/B 2026-07-02] The sticky hide STARVES the post-audio-init guest: MP4's PI
  // interrupt MASK reaches 0xffc (browser [vec-ring] cause/mask capture) — DSP(0x40)+AI(0x20)
  // are IN the guest's mask, i.e. the guest installs handlers and EXPECTS these interrupts
  // (ARQ/ARAM DMA completions). With them hidden, aramStoreData waits forever on the ARAM-DMA
  // interrupt -> the [A] wedge (browser: PC=0x80111bb0=aramStoreData+0x1b0, EE=0, exc=0x1,
  // [isr-reach]=0/0). The overrun the hide fixed was the EARLY no-handler era; by the time the
  // worker drives, the guest's own PI mask gates delivery correctly.
  static constexpr u32 DUALCORE_HIDE = 0u;
  const u32 phase_flags =
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x0268002Cu));
  if (phase_flags & 0x2u) g_dc_handover_done = 1;  // sticky: worker has engaged (dolphin_read32 uses it)
  const bool worker_driving = (phase_flags & 0x2u) != 0 || g_dc_handover_done != 0;
  const u32 eff_cause = m_interrupt_cause & ~(worker_driving ? DUALCORE_HIDE : 0u);
  // [STEP 2 cross-worker coherence 2026-07-09] The DEVICE worker (dolphin) writes EXTERNAL_INT
  // here; the CPU worker reads it with __atomic_load ACQUIRE (ppc_worker_main.cpp) and now vectors
  // it ITSELF (no cmd-10 round-trip). A plain |=/&= was same-thread-coherent for dolphin's old
  // in-thread delivery but is a stale-read window cross-thread. Atomic RMW with RELEASE pairs with
  // the worker's ACQUIRE load; the atomic AND/OR also can't lose a concurrent set/clear on the word.
  // [aram-diag 2026-07-16] post-takeover: is INT_CAUSE_DSP pending in eff_cause (0x026B270C), and does
  // it pass the guest PI mask into EXT (0x026B2710)? If 270C>0 but 2710==0, the guest never enabled
  // DSP in the PI interrupt mask (m_interrupt_mask) -> the ARAM completion is masked at the PI level.
  if (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u) {
    if ((eff_cause & INT_CAUSE_DSP) != 0) {
      volatile u32* p = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B270Cu));
      *p = *p + 1u;
      if ((eff_cause & INT_CAUSE_DSP & m_interrupt_mask) != 0) {
        volatile u32* q = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2710u));
        *q = *q + 1u;
      }
    }
  }
  if ((eff_cause & m_interrupt_mask) != 0)
    __atomic_or_fetch(&ppc_state.Exceptions, EXCEPTION_EXTERNAL_INT, __ATOMIC_RELEASE);
  else
    __atomic_and_fetch(&ppc_state.Exceptions, ~static_cast<u32>(EXCEPTION_EXTERNAL_INT), __ATOMIC_RELEASE);
  // [cause-fastpath 2026-07-17] Keep the guest-visible PI-cause mirror (0xCC003000 read value = cause
  // with INT_CAUSE_CP 0x800 hidden, matching dolphin_read32) fresh in SAB @0x026B27D0 so the worker's
  // ISR reads it DIRECTLY instead of a blocking mailbox round-trip. UpdateException runs on every
  // cause set/clear, so the mirror tracks the live cause. RELEASE store pairs with the worker's
  // Atomics.load(ACQUIRE). This is the throughput fix for the ARAM audio-init chain (oracle: native
  // ~400 ARAM DMAs/s vs our ~2/s, bottlenecked on per-ISR MMIO mailbox round-trips).
  __atomic_store_n(reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B27D0u)),
                   eff_cause & ~static_cast<u32>(0x800u), __ATOMIC_RELEASE);
}

static const char* Debug_GetInterruptName(u32 cause_mask)
{
  switch (cause_mask)
  {
  case INT_CAUSE_PI:
    return "INT_CAUSE_PI";
  case INT_CAUSE_DI:
    return "INT_CAUSE_DI";
  case INT_CAUSE_RSW:
    return "INT_CAUSE_RSW";
  case INT_CAUSE_SI:
    return "INT_CAUSE_SI";
  case INT_CAUSE_EXI:
    return "INT_CAUSE_EXI";
  case INT_CAUSE_AI:
    return "INT_CAUSE_AI";
  case INT_CAUSE_DSP:
    return "INT_CAUSE_DSP";
  case INT_CAUSE_MEMORY:
    return "INT_CAUSE_MEMORY";
  case INT_CAUSE_VI:
    return "INT_CAUSE_VI";
  case INT_CAUSE_PE_TOKEN:
    return "INT_CAUSE_PE_TOKEN";
  case INT_CAUSE_PE_FINISH:
    return "INT_CAUSE_PE_FINISH";
  case INT_CAUSE_CP:
    return "INT_CAUSE_CP";
  case INT_CAUSE_DEBUG:
    return "INT_CAUSE_DEBUG";
  case INT_CAUSE_WII_IPC:
    return "INT_CAUSE_WII_IPC";
  case INT_CAUSE_HSP:
    return "INT_CAUSE_HSP";
  case INT_CAUSE_RST_BUTTON:
    return "INT_CAUSE_RST_BUTTON";
  default:
    return "!!! ERROR-unknown Interrupt !!!";
  }
}

void ProcessorInterfaceManager::SetInterrupt(u32 cause_mask, bool set)
{
  DEBUG_ASSERT_MSG(POWERPC, Core::IsCPUThread(), "SetInterrupt from wrong thread");

  if (set && !(m_interrupt_cause & cause_mask))
  {
    DEBUG_LOG_FMT(PROCESSORINTERFACE, "Setting Interrupt {} (set)",
                  Debug_GetInterruptName(cause_mask));
  }

  if (!set && (m_interrupt_cause & cause_mask))
  {
    DEBUG_LOG_FMT(PROCESSORINTERFACE, "Setting Interrupt {} (clear)",
                  Debug_GetInterruptName(cause_mask));
  }

  if (set)
    m_interrupt_cause |= cause_mask;
  else
    m_interrupt_cause &= ~cause_mask;  // is there any reason to have this possibility?
  // F|RES: i think the hw devices reset the interrupt in the PI to 0
  // if the interrupt cause is eliminated. that isn't done by software (afaik)
  UpdateException();
}

void ProcessorInterfaceManager::SetResetButton(bool set)
{
  SetInterrupt(INT_CAUSE_RST_BUTTON, !set);
}

void ProcessorInterfaceManager::ToggleResetButtonCallback(Core::System& system, u64 userdata,
                                                          s64 cyclesLate)
{
  system.GetProcessorInterface().SetResetButton(!!userdata);
}

void ProcessorInterfaceManager::IOSNotifyResetButtonCallback(Core::System& system, u64 userdata,
                                                             s64 cyclesLate)
{
  const auto ios = system.GetIOS();
  if (!ios)
    return;

  auto stm = ios->GetDeviceByName("/dev/stm/eventhook");
  if (stm)
    std::static_pointer_cast<IOS::HLE::STMEventHookDevice>(stm)->ResetButton();
}

void ProcessorInterfaceManager::IOSNotifyPowerButtonCallback(Core::System& system, u64 userdata,
                                                             s64 cyclesLate)
{
  const auto ios = system.GetIOS();
  if (!ios)
    return;

  auto stm = ios->GetDeviceByName("/dev/stm/eventhook");
  if (stm)
    std::static_pointer_cast<IOS::HLE::STMEventHookDevice>(stm)->PowerButton();
}

void ProcessorInterfaceManager::ResetButton_Tap()
{
  if (!Core::IsRunning(m_system))
    return;

  auto& core_timing = m_system.GetCoreTiming();
  core_timing.ScheduleEvent(0, m_event_type_toggle_reset_button, true, CoreTiming::FromThread::ANY);
  core_timing.ScheduleEvent(0, m_event_type_ios_notify_reset_button, 0,
                            CoreTiming::FromThread::ANY);
  core_timing.ScheduleEvent(m_system.GetSystemTimers().GetTicksPerSecond() / 2,
                            m_event_type_toggle_reset_button, false, CoreTiming::FromThread::ANY);
}

void ProcessorInterfaceManager::PowerButton_Tap()
{
  if (!Core::IsRunning(m_system))
    return;

  auto& core_timing = m_system.GetCoreTiming();
  core_timing.ScheduleEvent(0, m_event_type_ios_notify_power_button, 0,
                            CoreTiming::FromThread::ANY);
}

}  // namespace ProcessorInterface
