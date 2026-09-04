// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "Core/PowerPC/PowerPC.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cstring>

#include "Common/Assert.h"
#include "Common/ChunkFile.h"
#include "Common/CommonTypes.h"
#include "Common/FPURoundMode.h"
#include "Common/FloatUtils.h"
#include "Common/Logging/Log.h"

#include "Core/CPUThreadConfigCallback.h"
#include "Core/Config/MainSettings.h"
#include "Core/Core.h"
#include "Core/CoreTiming.h"
#include "Core/HW/CPU.h"
#include "Core/HW/Memmap.h"  // [os-ready gate] GetRAM for the MEM[0xC0] check
#include "Core/HW/ProcessorInterface.h"

extern "C" u32 g_in_cmd10;  // worker-requested delivery in progress; defined in dolphin_jit_wimports.cpp
#include "Core/HW/SystemTimers.h"
#include "Core/Host.h"
#include "Core/PowerPC/CPUCoreBase.h"
#include "Core/PowerPC/GDBStub.h"
#include "Core/PowerPC/Interpreter/Interpreter.h"
#include "Core/PowerPC/JitInterface.h"
#include "Core/PowerPC/MMU.h"
#include "Core/PowerPC/PPCSymbolDB.h"
#include "Core/System.h"

namespace PowerPC
{
double PairedSingle::PS0AsDouble() const
{
  return std::bit_cast<double>(ps0);
}

double PairedSingle::PS1AsDouble() const
{
  return std::bit_cast<double>(ps1);
}

void PairedSingle::SetPS0(double value)
{
  ps0 = std::bit_cast<u64>(value);
}

void PairedSingle::SetPS1(double value)
{
  ps1 = std::bit_cast<u64>(value);
}

static void InvalidateCacheThreadSafe(Core::System& system, u64 userdata, s64 cyclesLate)
{
  system.GetPPCState().iCache.Invalidate(system.GetMemory(), system.GetJitInterface(),
                                         static_cast<u32>(userdata));
  Host_JitCacheInvalidation();
}

PowerPCManager::PowerPCManager(Core::System& system)
    :
#if defined(__EMSCRIPTEN__)
      // [ppc-state-collapse] bind m_ppc_state onto the shared SAB slice-state (see PowerPC.h).
      m_ppc_state(*reinterpret_cast<PowerPCState*>(static_cast<uintptr_t>(0x02400000u))),
#endif
      m_breakpoints(system), m_memchecks(system), m_debug_interface(system, m_symbol_db),
      m_system(system)
{
}

PowerPCManager::~PowerPCManager() = default;

void PowerPCManager::DoState(PointerWrap& p)
{
  // some of this code has been disabled, because
  // it changes registers even in Mode::Measure (which is suspicious and seems like it could cause
  // desyncs)
  // and because the values it's changing have been added to CoreTiming::DoState, so it might
  // conflict to mess with them here.

  // m_ppc_state.spr[SPR_DEC] = SystemTimers::GetFakeDecrementer();
  // *((u64 *)&TL(m_ppc_state)) = SystemTimers::GetFakeTimeBase(); //works since we are little
  // endian and TL comes first :)

  const std::array<u32, 16> old_sr = m_ppc_state.sr;

  p.DoArray(m_ppc_state.gpr);
  p.Do(m_ppc_state.pc);
  p.Do(m_ppc_state.npc);
  p.DoArray(m_ppc_state.cr.fields);
  p.Do(m_ppc_state.msr);
  p.Do(m_ppc_state.fpscr);
  p.Do(m_ppc_state.Exceptions);
  p.Do(m_ppc_state.downcount);
  p.Do(m_ppc_state.xer_ca);
  p.Do(m_ppc_state.xer_so_ov);
  p.Do(m_ppc_state.xer_stringctrl);
  p.DoArray(m_ppc_state.ps);
  p.DoArray(m_ppc_state.sr);
  p.DoArray(m_ppc_state.spr);
  p.DoArray(m_ppc_state.tlb);
  p.Do(m_ppc_state.pagetable_base);
  p.Do(m_ppc_state.pagetable_mask);
  p.Do(m_ppc_state.pagetable_update_pending);

  p.Do(m_ppc_state.reserve);
  p.Do(m_ppc_state.reserve_address);

  auto& memory = m_system.GetMemory();
  m_ppc_state.iCache.DoState(memory, p);
  m_ppc_state.dCache.DoState(memory, p);

  auto& mmu = m_system.GetMMU();
  if (p.IsReadMode())
  {
    mmu.DoState(p, old_sr != m_ppc_state.sr);

    if (!m_ppc_state.m_enable_dcache)
    {
      INFO_LOG_FMT(POWERPC, "Flushing data cache");
      m_ppc_state.dCache.FlushAll(memory);
    }

    RoundingModeUpdated(m_ppc_state);
    RecalculateAllFeatureFlags(m_ppc_state);

    mmu.IBATUpdated();
    mmu.DBATUpdated();
  }
  else
  {
    mmu.DoState(p, false);
  }

  // SystemTimers::DecrementerSet();
  // SystemTimers::TimeBaseSet();

  m_system.GetJitInterface().DoState(p);
}

void PowerPCManager::ResetRegisters()
{
  std::ranges::fill(m_ppc_state.ps, PairedSingle{});
  std::ranges::fill(m_ppc_state.sr, 0U);
  std::ranges::fill(m_ppc_state.gpr, 0U);
  std::ranges::fill(m_ppc_state.spr, 0U);

  // Gamecube:
  // 0x00080200 = lonestar 2.0
  // 0x00088202 = lonestar 2.2
  // 0x70000100 = gekko 1.0
  // 0x00080100 = gekko 2.0
  // 0x00083203 = gekko 2.3a
  // 0x00083213 = gekko 2.3b
  // 0x00083204 = gekko 2.4
  // 0x00083214 = gekko 2.4e (8SE) - retail HW2
  // Wii:
  // 0x00087102 = broadway retail hw
  if (m_system.IsWii())
  {
    m_ppc_state.spr[SPR_PVR] = 0x00087102;
  }
  else
  {
    m_ppc_state.spr[SPR_PVR] = 0x00083214;
  }
  m_ppc_state.spr[SPR_HID1] = 0x80000000;  // We're running at 3x the bus clock
  m_ppc_state.spr[SPR_ECID_U] = 0x0d96e200;
  m_ppc_state.spr[SPR_ECID_M] = 0x1840c00d;
  m_ppc_state.spr[SPR_ECID_L] = 0x82bb08e8;

  m_ppc_state.fpscr.Hex = 0;
  m_ppc_state.pc = 0;
  m_ppc_state.npc = 0;
  m_ppc_state.Exceptions = 0;

  m_ppc_state.reserve = false;
  m_ppc_state.reserve_address = 0;

  for (auto& v : m_ppc_state.cr.fields)
  {
    v = 0x8000000000000001;
  }
  m_ppc_state.SetXER({});

  auto& mmu = m_system.GetMMU();
  mmu.DBATUpdated();
  mmu.IBATUpdated();

  auto& system_timers = m_system.GetSystemTimers();
  TL(m_ppc_state) = 0;
  TU(m_ppc_state) = 0;
  system_timers.TimeBaseSet();

  // MSR should be 0x40, but we don't emulate BS1, so it would never be turned off :}
  m_ppc_state.msr.Hex = 0;
  m_ppc_state.spr[SPR_DEC] = 0xFFFFFFFF;
  system_timers.DecrementerSet();

  RoundingModeUpdated(m_ppc_state);
  RecalculateAllFeatureFlags(m_ppc_state);
}

void PowerPCManager::InitializeCPUCore(CPUCore cpu_core)
{
  // We initialize the interpreter because
  // it is used on boot and code window independently.
  auto& interpreter = m_system.GetInterpreter();
  interpreter.Init();

  switch (cpu_core)
  {
  case CPUCore::Interpreter:
    m_cpu_core_base = &interpreter;
    break;

  default:
    m_cpu_core_base = m_system.GetJitInterface().InitJitCore(cpu_core);
    if (!m_cpu_core_base)  // Handle Situations where JIT core isn't available
    {
      WARN_LOG_FMT(POWERPC, "CPU core {} not available. Falling back to default.",
                   static_cast<int>(cpu_core));
      m_cpu_core_base = m_system.GetJitInterface().InitJitCore(DefaultCPUCore());
    }
    break;
  }

  m_mode = m_cpu_core_base == &interpreter ? CoreMode::Interpreter : CoreMode::JIT;
}

std::span<const CPUCore> AvailableCPUCores()
{
  static constexpr auto cpu_cores = {
#ifdef _M_X86_64
      CPUCore::JIT64,
#elif defined(_M_ARM_64)
      CPUCore::JITARM64,
#endif
#ifdef __EMSCRIPTEN__
      CPUCore::WasmJIT,
#endif
      CPUCore::CachedInterpreter,
      CPUCore::Interpreter,
  };

  return cpu_cores;
}

CPUCore DefaultCPUCore()
{
#ifdef _M_X86_64
  return CPUCore::JIT64;
#elif defined(_M_ARM_64)
  return CPUCore::JITARM64;
#elif defined(__EMSCRIPTEN__)
  return CPUCore::WasmJIT;
#else
  return CPUCore::CachedInterpreter;
#endif
}

void PowerPCManager::RefreshConfig()
{
  const bool old_enable_dcache = m_ppc_state.m_enable_dcache;

  m_ppc_state.m_enable_dcache = Config::Get(Config::MAIN_ACCURATE_CPU_CACHE);

  if (old_enable_dcache && !m_ppc_state.m_enable_dcache)
  {
    INFO_LOG_FMT(POWERPC, "Flushing data cache");
    m_ppc_state.dCache.FlushAll(m_system.GetMemory());
  }
}

void PowerPCManager::Init(CPUCore cpu_core)
{
  m_registered_config_callback_id =
      CPUThreadConfigCallback::AddConfigChangedCallback([this] { RefreshConfig(); });
  RefreshConfig();

  m_invalidate_cache_thread_safe =
      m_system.GetCoreTiming().RegisterEvent("invalidateEmulatedCache", InvalidateCacheThreadSafe);

  Reset();

  InitializeCPUCore(cpu_core);
  auto& memory = m_system.GetMemory();
  m_ppc_state.iCache.Init(memory);
  m_ppc_state.dCache.Init(memory);
}

void PowerPCManager::Reset()
{
  m_ppc_state.pagetable_base = 0;
  m_ppc_state.pagetable_mask = 0;
  m_ppc_state.pagetable_update_pending = false;
  m_ppc_state.tlb = {};

  ResetRegisters();
  m_ppc_state.iCache.Reset(m_system.GetJitInterface());
  m_ppc_state.dCache.Reset();
  m_system.GetMMU().Reset();
}

void PowerPCManager::ScheduleInvalidateCacheThreadSafe(u32 address)
{
  auto& cpu = m_system.GetCPU();

  if (cpu.GetState() == CPU::State::Running && !Core::IsCPUThread())
  {
    m_system.GetCoreTiming().ScheduleEvent(0, m_invalidate_cache_thread_safe, address,
                                           CoreTiming::FromThread::NON_CPU);
  }
  else
  {
    m_ppc_state.iCache.Invalidate(m_system.GetMemory(), m_system.GetJitInterface(),
                                  static_cast<u32>(address));
    Host_JitCacheInvalidation();
  }
}

void PowerPCManager::Shutdown()
{
  CPUThreadConfigCallback::RemoveConfigChangedCallback(m_registered_config_callback_id);
  InjectExternalCPUCore(nullptr);
  m_system.GetJitInterface().Shutdown();
  m_system.GetInterpreter().Shutdown();
  m_cpu_core_base = nullptr;
}

CoreMode PowerPCManager::GetMode() const
{
  return !m_cpu_core_base_is_injected ? m_mode : CoreMode::Interpreter;
}

void PowerPCManager::ApplyMode()
{
  auto& interpreter = m_system.GetInterpreter();

  switch (m_mode)
  {
  case CoreMode::Interpreter:  // Switching from JIT to interpreter
    m_cpu_core_base = &interpreter;
    break;

  case CoreMode::JIT:  // Switching from interpreter to JIT.
    // Don't really need to do much. It'll work, the cache will refill itself.
    m_cpu_core_base = m_system.GetJitInterface().GetCore();
    if (!m_cpu_core_base)  // Has a chance to not get a working JIT core if one isn't active on host
      m_cpu_core_base = &interpreter;
    break;
  }
}

void PowerPCManager::SetMode(CoreMode new_mode)
{
  if (new_mode == m_mode)
    return;  // We don't need to do anything.

  m_mode = new_mode;

  // If we're using an external CPU core implementation then don't do anything.
  if (m_cpu_core_base_is_injected)
    return;

  ApplyMode();
}

const char* PowerPCManager::GetCPUName() const
{
  return m_cpu_core_base->GetName();
}

void PowerPCManager::InjectExternalCPUCore(CPUCoreBase* new_cpu)
{
  // Previously injected.
  if (m_cpu_core_base_is_injected)
    m_cpu_core_base->Shutdown();

  // nullptr means just remove
  if (!new_cpu)
  {
    if (m_cpu_core_base_is_injected)
    {
      m_cpu_core_base_is_injected = false;
      ApplyMode();
    }
    return;
  }

  new_cpu->Init();
  m_cpu_core_base = new_cpu;
  m_cpu_core_base_is_injected = true;
}

void PowerPCManager::SingleStep()
{
  m_cpu_core_base->SingleStep();
}

void PowerPCManager::RunLoop()
{
  m_cpu_core_base->Run();
  Host_UpdateDisasmDialog();
}

u64 PowerPCManager::ReadFullTimeBaseValue() const
{
  u64 value;
  std::memcpy(&value, &TL(m_ppc_state), sizeof(value));
  return value;
}

void PowerPCManager::WriteFullTimeBaseValue(u64 value)
{
  std::memcpy(&TL(m_ppc_state), &value, sizeof(value));
}

void UpdatePerformanceMonitor(u32 cycles, u32 num_load_stores, u32 num_fp_inst,
                              PowerPCState& ppc_state)
{
  switch (MMCR0(ppc_state).PMC1SELECT)
  {
  case 0:  // No change
    break;
  case 1:  // Processor cycles
    ppc_state.spr[SPR_PMC1] += cycles;
    break;
  default:
    break;
  }

  switch (MMCR0(ppc_state).PMC2SELECT)
  {
  case 0:  // No change
    break;
  case 1:  // Processor cycles
    ppc_state.spr[SPR_PMC2] += cycles;
    break;
  case 11:  // Number of loads and stores completed
    ppc_state.spr[SPR_PMC2] += num_load_stores;
    break;
  default:
    break;
  }

  switch (MMCR1(ppc_state).PMC3SELECT)
  {
  case 0:  // No change
    break;
  case 1:  // Processor cycles
    ppc_state.spr[SPR_PMC3] += cycles;
    break;
  case 11:  // Number of FPU instructions completed
    ppc_state.spr[SPR_PMC3] += num_fp_inst;
    break;
  default:
    break;
  }

  switch (MMCR1(ppc_state).PMC4SELECT)
  {
  case 0:  // No change
    break;
  case 1:  // Processor cycles
    ppc_state.spr[SPR_PMC4] += cycles;
    break;
  default:
    break;
  }

  if ((MMCR0(ppc_state).PMC1INTCONTROL && (ppc_state.spr[SPR_PMC1] & 0x80000000) != 0) ||
      (MMCR0(ppc_state).PMCINTCONTROL && (ppc_state.spr[SPR_PMC2] & 0x80000000) != 0) ||
      (MMCR0(ppc_state).PMCINTCONTROL && (ppc_state.spr[SPR_PMC3] & 0x80000000) != 0) ||
      (MMCR0(ppc_state).PMCINTCONTROL && (ppc_state.spr[SPR_PMC4] & 0x80000000) != 0))
  {
    ppc_state.Exceptions |= EXCEPTION_PERFORMANCE_MONITOR;
  }
}

void PowerPCManager::CheckExceptions()
{
  u32 exceptions = m_ppc_state.Exceptions;

#if defined(__EMSCRIPTEN__)
  // [os-ready sync-hold REVERTED 2026-07-03: starved boot to retired=3058 (a held DSI
  //  re-faults forever); and the orbit seed proved to be an rfi/branch entry, not a
  //  delivery — see gc_executor_collapse_plan.md]

  // [single-owner SYNC gate TRIED AND REVERTED 2026-07-09 — do not re-add as a bare
  // defer] Gating sync arms on (owner==1 && !g_in_cmd10) REGRESSED: halt 2/6 (350/491
  // hits), reconcileN stayed 1024-2304, ir1 persisted. Mechanism: sync exceptions
  // raised inside SingleStepInner (mid-op DSI/ISI from the worker's cmd-9 interp) are
  // load-bearing when delivered synchronously WITH the faulting op — defer-to-boundary
  // lets the block's remaining emitted ops run on half-advanced state, then delivers a
  // wrong resume image. Owner-coherence for sync delivery therefore needs delivery AT
  // THE POINT OF RAISE under a changed emitted-code contract (block honors a
  // "delivered" signal from the interp import), not an entry gate. The stale-cursor
  // race is handled at the consumer instead: ppc_worker.js [deliv-reconcile]
  // (halt 0/6, verified 2026-07-09).
#endif


  // Example procedure:
  // Set SRR0 to either PC or NPC
  // SRR0 = NPC;
  //
  // Save specified MSR bits
  // SRR1 = MSR.Hex & 0x87C0FFFF;
  //
  // Copy ILE bit to LE
  // MSR.LE = MSR.ILE;
  //
  // Clear MSR as specified
  // MSR.Hex &= ~0x04EF36; // 0x04FF36 also clears ME (only for machine check exception)
  //
  // Set to exception type entry point
  // NPC = 0x00000x00;

  // TODO(delroth): Exception priority is completely wrong here: depending on
  // the instruction class, exceptions should be executed in a given order,
  // which is very different from the one arbitrarily chosen here. See §6.1.5
  // in 6xx_pem.pdf.

  if (exceptions & EXCEPTION_ISI)
  {
    SRR0(m_ppc_state) = m_ppc_state.npc;
    // Page fault occurred
    SRR1(m_ppc_state) = (m_ppc_state.msr.Hex & 0x87C0FFFF) | (1 << 30);
    m_ppc_state.msr.LE = m_ppc_state.msr.ILE;
    m_ppc_state.msr.Hex &= ~0x04EF36;
#ifdef __EMSCRIPTEN__
  // [me-preserve 2026-07-07] real HW keeps ME set through interrupt delivery (GC never
  // runs ME-less; msr=0 is fatal). The dolphin-executor intermittently drops ME
  // pre-takeover (the documented ME-drop, powerpc-next msr-handling — separate audit);
  // delivery from an 0x8032-class context then computed msr=0x0000 and wedged the
  // post-takeover guest. Make the mutation robust: ME survives delivery uncondionally.
  m_ppc_state.msr.Hex |= 0x1000;
#endif
    m_ppc_state.pc = m_ppc_state.npc = 0x00000400;

    DEBUG_LOG_FMT(POWERPC, "EXCEPTION_ISI");
    m_ppc_state.Exceptions &= ~EXCEPTION_ISI;
  }
  else if (exceptions & EXCEPTION_PROGRAM)
  {
    SRR0(m_ppc_state) = m_ppc_state.pc;
    // SRR1 was partially set by GenerateProgramException, so bitwise or is used here
    SRR1(m_ppc_state) |= m_ppc_state.msr.Hex & 0x87C0FFFF;
    m_ppc_state.msr.LE = m_ppc_state.msr.ILE;
    m_ppc_state.msr.Hex &= ~0x04EF36;
#ifdef __EMSCRIPTEN__
  // [me-preserve 2026-07-07] real HW keeps ME set through interrupt delivery (GC never
  // runs ME-less; msr=0 is fatal). The dolphin-executor intermittently drops ME
  // pre-takeover (the documented ME-drop, powerpc-next msr-handling — separate audit);
  // delivery from an 0x8032-class context then computed msr=0x0000 and wedged the
  // post-takeover guest. Make the mutation robust: ME survives delivery uncondionally.
  m_ppc_state.msr.Hex |= 0x1000;
#endif
    m_ppc_state.pc = m_ppc_state.npc = 0x00000700;

    DEBUG_LOG_FMT(POWERPC, "EXCEPTION_PROGRAM");
    m_ppc_state.Exceptions &= ~EXCEPTION_PROGRAM;
  }
  else if (exceptions & EXCEPTION_SYSCALL)
  {
    SRR0(m_ppc_state) = m_ppc_state.npc;
    SRR1(m_ppc_state) = m_ppc_state.msr.Hex & 0x87C0FFFF;
    m_ppc_state.msr.LE = m_ppc_state.msr.ILE;
    m_ppc_state.msr.Hex &= ~0x04EF36;
#ifdef __EMSCRIPTEN__
  // [me-preserve 2026-07-07] real HW keeps ME set through interrupt delivery (GC never
  // runs ME-less; msr=0 is fatal). The dolphin-executor intermittently drops ME
  // pre-takeover (the documented ME-drop, powerpc-next msr-handling — separate audit);
  // delivery from an 0x8032-class context then computed msr=0x0000 and wedged the
  // post-takeover guest. Make the mutation robust: ME survives delivery uncondionally.
  m_ppc_state.msr.Hex |= 0x1000;
#endif
    m_ppc_state.pc = m_ppc_state.npc = 0x00000C00;

    DEBUG_LOG_FMT(POWERPC, "EXCEPTION_SYSCALL (PC={:08x})", m_ppc_state.pc);
    m_ppc_state.Exceptions &= ~EXCEPTION_SYSCALL;
  }
  else if (exceptions & EXCEPTION_FPU_UNAVAILABLE)
  {
    // This happens a lot - GameCube OS uses deferred FPU context switching
    SRR0(m_ppc_state) = m_ppc_state.pc;  // re-execute the instruction
    SRR1(m_ppc_state) = m_ppc_state.msr.Hex & 0x87C0FFFF;
    m_ppc_state.msr.LE = m_ppc_state.msr.ILE;
    m_ppc_state.msr.Hex &= ~0x04EF36;
#ifdef __EMSCRIPTEN__
  // [me-preserve 2026-07-07] real HW keeps ME set through interrupt delivery (GC never
  // runs ME-less; msr=0 is fatal). The dolphin-executor intermittently drops ME
  // pre-takeover (the documented ME-drop, powerpc-next msr-handling — separate audit);
  // delivery from an 0x8032-class context then computed msr=0x0000 and wedged the
  // post-takeover guest. Make the mutation robust: ME survives delivery uncondionally.
  m_ppc_state.msr.Hex |= 0x1000;
#endif
    m_ppc_state.pc = m_ppc_state.npc = 0x00000800;

    DEBUG_LOG_FMT(POWERPC, "EXCEPTION_FPU_UNAVAILABLE");
    m_ppc_state.Exceptions &= ~EXCEPTION_FPU_UNAVAILABLE;
  }
  else if (exceptions & EXCEPTION_FAKE_MEMCHECK_HIT)
  {
    m_ppc_state.Exceptions &= ~EXCEPTION_DSI & ~EXCEPTION_FAKE_MEMCHECK_HIT;
  }
  else if (exceptions & EXCEPTION_DSI)
  {
    SRR0(m_ppc_state) = m_ppc_state.pc;
    SRR1(m_ppc_state) = m_ppc_state.msr.Hex & 0x87C0FFFF;
    m_ppc_state.msr.LE = m_ppc_state.msr.ILE;
    m_ppc_state.msr.Hex &= ~0x04EF36;
#ifdef __EMSCRIPTEN__
  // [me-preserve 2026-07-07] real HW keeps ME set through interrupt delivery (GC never
  // runs ME-less; msr=0 is fatal). The dolphin-executor intermittently drops ME
  // pre-takeover (the documented ME-drop, powerpc-next msr-handling — separate audit);
  // delivery from an 0x8032-class context then computed msr=0x0000 and wedged the
  // post-takeover guest. Make the mutation robust: ME survives delivery uncondionally.
  m_ppc_state.msr.Hex |= 0x1000;
#endif
    m_ppc_state.pc = m_ppc_state.npc = 0x00000300;
    // DSISR and DAR regs are changed in GenerateDSIException()

    DEBUG_LOG_FMT(POWERPC, "EXCEPTION_DSI");
    m_ppc_state.Exceptions &= ~EXCEPTION_DSI;
  }
  else if (exceptions & EXCEPTION_ALIGNMENT)
  {
    SRR0(m_ppc_state) = m_ppc_state.pc;
    SRR1(m_ppc_state) = m_ppc_state.msr.Hex & 0x87C0FFFF;
    m_ppc_state.msr.LE = m_ppc_state.msr.ILE;
    m_ppc_state.msr.Hex &= ~0x04EF36;
#ifdef __EMSCRIPTEN__
  // [me-preserve 2026-07-07] real HW keeps ME set through interrupt delivery (GC never
  // runs ME-less; msr=0 is fatal). The dolphin-executor intermittently drops ME
  // pre-takeover (the documented ME-drop, powerpc-next msr-handling — separate audit);
  // delivery from an 0x8032-class context then computed msr=0x0000 and wedged the
  // post-takeover guest. Make the mutation robust: ME survives delivery uncondionally.
  m_ppc_state.msr.Hex |= 0x1000;
#endif
    m_ppc_state.pc = m_ppc_state.npc = 0x00000600;

    // TODO crazy amount of DSISR options to check out

    DEBUG_LOG_FMT(POWERPC, "EXCEPTION_ALIGNMENT");
    m_ppc_state.Exceptions &= ~EXCEPTION_ALIGNMENT;
  }
  else
  {
    // EXTERNAL INTERRUPT
    CheckExternalExceptions();
    return;
  }

#ifdef __EMSCRIPTEN__
  // [deliv-gen MONOTONIC 2026-07-09 — FUNCTIONAL] Bump the DELIVERY GENERATION at
  // SAB 0x026B0970 on every vectored SYNC delivery. The worker's deliv-reconcile
  // (ppc_worker.js) reads this monotonic head to adopt a dolphin-delivered redirect
  // BEFORE dispatching; a stale/aliased generation left the redirect un-reconciled
  // (the reconN=0 halt). Load-bearing dual-core coordination, not telemetry.
  {
    volatile u32* const hd = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B0970u));
    *hd = *hd + 1u;
  }
#endif
  MSRUpdated();
}

#ifdef __EMSCRIPTEN__
// [os-ready gate, generalized 2026-09-04 — the 240pSuite fix]
//
// WHAT THE OLD GATE DID. `CheckExternalExceptions` and `dolphin_check_exc` both refused
// to vector ANY maskable exception (EXTERNAL_INT / DECREMENTER) unless MEM[0x800000C0]
// held a plausible physical MEM1 pointer. That address is the NINTENDO SDK's
// `OSCurrentContext`, and the gate exists because the SDK's canonical 0x500 stub
// dereferences it: a boot-era delivery with MEM[0xC0] garbage (0x074d5045) sent
// OSDefaultExceptionHandler orbiting on a null stack (~470k mailbox calls/60s).
//
// WHY IT WAS WRONG. `OSCurrentContext` is an SDK convention, not hardware. libogc's
// exception stubs build their frame from the CURRENT STACK POINTER and never touch
// MEM[0xC0], so a libogc title leaves that word 0 for its entire life — CONFIRMED on
// native Dolphin (GDB stub, dual-core, 240pSuite-1.10b.dol: MEM[0xC0..0xCF] read all
// zeroes at every one of 6 breakpoint hits while the suite rendered normally).
// Against such a guest the gate never opens, so EXT and DEC can never be delivered.
// Measured consequence (probe log /tmp/gcw/suite240p-cold.log, .wasm md5
// 82bc8f8b6e1c6ac8db27ec0a5d49dadb): ppc_state.Exceptions stuck at 0x5
// (DECREMENTER|EXTERNAL_INT), pc frozen at 0x80009374 — the instruction after the
// `mtmsr` in libogc's context switch that first sets MSR.EE — for 32 of 33 sampled
// windows, 0 credited MHz, 0 drawn/s, 0 published/s, black canvas.
//
// THE DISCRIMINATOR. Ask the installed stub itself whether it needs MEM[0xC0]. The
// SDK stub's SECOND word is `lwz r4, 0xC0(r0)` (0x808000C0); libogc's second word is
// `clrlwi r4, r1, 2` (0x542400BE). Measured over every captured probe run in
// /tmp/gcw: MP4, SAB and PSO all carry an `lwz rD, 0xC0(r0)` at word 1 of their 0x500
// stub AND a valid MEM[0xC0]; 240pSuite carries neither. So gating on the presence of
// that load keeps the SDK titles on exactly the old behaviour and unblocks libogc.
//
// The "is a stub installed at all" check (word0 nonzero / not 0xFFFFFFFF) preserves
// the boot-era protection the MEM[0xC0] test used to provide incidentally: nothing
// vectors into a vector page the guest has not written yet.
bool MaskableVectorGateSatisfied(Core::System& system)
{
  const u8* ram0 = system.GetMemory().GetRAM();
  if (!ram0)
    return false;
  const auto read32 = [ram0](u32 off) {
    return (u32(ram0[off]) << 24) | (u32(ram0[off + 1]) << 16) | (u32(ram0[off + 2]) << 8) |
           u32(ram0[off + 3]);
  };

  // External-interrupt vector (0x500). DEC vectors to 0x900, but both are installed by
  // the same OS routine and share a stub family, so 0x500 is the representative probe.
  const u32 stub0 = read32(0x500);
  if (stub0 == 0u || stub0 == 0xFFFFFFFFu)
    return false;  // vector page not installed yet.

  // Does the stub load from low memory 0xC0..0xDF off r0? That window is the SDK's
  // OSCurrentContext (0xC0) / OSCurrentFPUContext (0xD4).
  bool needs_os_context = false;
  for (u32 i = 0; i < 8u; ++i)
  {
    const u32 inst = read32(0x500 + i * 4u);
    const u32 opcode = inst >> 26;
    const u32 ra = (inst >> 16) & 0x1Fu;
    const u32 disp = inst & 0xFFFFu;
    if (opcode == 32u && ra == 0u && disp >= 0xC0u && disp <= 0xDFu)  // lwz rD, disp(r0)
    {
      needs_os_context = true;
      break;
    }
  }
  if (!needs_os_context)
    return true;  // stub is self-contained (libogc): safe to vector.

  const u32 os_ctx = read32(0xC0);
  return os_ctx != 0u && os_ctx < 0x01800000u;
}
#endif

void PowerPCManager::CheckExternalExceptions()
{
#ifdef __EMSCRIPTEN__
  // [takeover-gate strip 2026-07-22 — native-exact delivery] The torn-send mailbox gate
  // (mbx cmd 5-7) and the slice-active gate (SAB 0x026B1A00) are DELETED. Both guarded the
  // ppc-worker takeover's mailbox-round-trip store windows — a topology that no longer exists
  // (the in-process EmuThread executes guest stores directly; the worker never owns the CPU).
  // The slice-active flag was WORSE than dead: the boot handshake's single dispatch round-trip
  // sets 0x026B1A00=1 (ppc_worker.js:2200) and the no-takeover path can leave it set forever,
  // gating ALL autonomous EXTERNAL_INT delivery. One-shot interrupts (ARAM-DMA completion #10)
  // then outwaited the guest's own DSP_CONTROL poll-write, which ack-cleared the cause before
  // delivery — audio-init froze at aramWrite=0x4500, overlay never started, DVD read 12 never
  // issued (MP4 boot stall; VI survived only because it re-fires every frame). Native delivers
  // at the first EE=1 boundary with no such gates.
#endif
#ifdef __EMSCRIPTEN__
  // [os-ready gate 2026-07-03 — choke point] Hold ALL maskable delivery until MEM[0xC0]
  // (OSCurrentContext, stored as a PHYSICAL MEM1 pointer, e.g. 0x001a5b38) is valid. The
  // r1=0 orbit was seeded at gt=841 by a boot-era dispatch through the canonical stub with
  // MEM[0xC0]=garbage (0x074d5045) -> OSDefaultExceptionHandler looped on a null stack
  // forever (~470k mailbox calls/60s). dolphin_check_exc has the same gate, but boot-era
  // callers (JitWasm.cpp:287 via the terminal else, CoreTiming Advance) bypass it — this is
  // the single funnel every route shares.
  //
  // [libogc fix 2026-09-04] The MEM[0xC0] test is now CONDITIONAL on the installed stub
  // (PowerPC::MaskableVectorGateSatisfied below). Unconditional, it made 240pSuite
  // permanently un-bootable — see that function's comment.
  if (!PowerPC::MaskableVectorGateSatisfied(m_system))
    return;  // exception stubs not ready to receive a maskable vector.
#endif
  u32 exceptions = m_ppc_state.Exceptions;

  // EXTERNAL INTERRUPT
  // Handling is delayed until MSR.EE=1.
#if defined(__EMSCRIPTEN__)
  // [takeover-gate strip 2026-07-22] single-owner delivery gate DELETED with the takeover
  // architecture (cpu_owner is never 1 in the native dual-core topology; see the strip note
  // at the top of this function).
#endif
  if (exceptions && m_ppc_state.msr.EE)
  {
    if (exceptions & EXCEPTION_EXTERNAL_INT)
    {
#if defined(__EMSCRIPTEN__)
      // [npc-sync — root fix of the deterministic PC=0 ISI, common delivery point] Upstream keeps the
      // do_timing invariant NPC=PC=DISPATCHER_PC, so at an external-interrupt boundary npc==pc and SRR0
      // = the instruction about to execute. Our dual-core block-dispatch/chain path advances pc per
      // block but leaves npc at an OLD value (observed npc=0x80010640, an old HuSprDisp epilogue, while
      // pc=0x8000d9f8 in HuSprExec) on some delivery routes (JIT-emitted CheckExternalExceptionsFromJIT).
      // SRR0=stale-npc then rfi's the guest into a dead frame -> blr 0. Enforce the boundary invariant
      // here, the single site all routes funnel through, so SRR0 = the true interrupted pc.
      if (m_ppc_state.npc != m_ppc_state.pc)
        m_ppc_state.npc = m_ppc_state.pc;
#endif
#ifdef __EMSCRIPTEN__
      // [ee-gate — PERMANENT, Step 2] No external interrupt vectors with the interrupted
      // context at EE=0. PLACEMENT FIX 2026-07-07: the gate previously ran AFTER the
      // SRR0/SRR1 writes — a REFUSAL still clobbered the live SPRs (destroying an
      // in-flight ISR's resume image; its rfi then restored an EE=0 msr → the idle-spin
      // EE=0 wedge). HW touches SRR0/SRR1 only when delivery COMMITS — gate FIRST.
      if (!m_ppc_state.msr.EE)
      {
        return;
      }
      // [vector-page deliv gate 2026-07-09 — PERMANENT] Never deliver an external
      // interrupt while the interrupted context is INSIDE an exception vector stub
      // (pc < 0x4000). Native runs the stubs with EE=0 (masked), so it NEVER takes a
      // nested async interrupt there; a delivery here saves SRR0 = the vector addr
      // (0x500), and a later OSLoadContext rfi back into that bogus context resumes
      // the stub under IR=1 → the 0x594 fetch-translation ISI → PPCHalt (symbolized
      // 2026-07-09: OSLoadContext SRR0=0x500, msr=0x1030). Gate BEFORE the SRR0/SRR1
      // writes (same placement rule as the ee-gate above — a refusal must not clobber
      // the live SPRs). Bits stay pending; delivered once the guest leaves the stub
      // (the stub's rfi restores an EE=1 non-vector context).
      if (m_ppc_state.pc < 0x4000u)
      {
        return;
      }
#endif
      // Pokemon gets this "too early", it hasn't a handler yet
      SRR0(m_ppc_state) = m_ppc_state.npc;
      SRR1(m_ppc_state) = m_ppc_state.msr.Hex & 0x87C0FFFF;
      m_ppc_state.msr.LE = m_ppc_state.msr.ILE;
      m_ppc_state.msr.Hex &= ~0x04EF36;
#ifdef __EMSCRIPTEN__
  // [me-preserve 2026-07-07] real HW keeps ME set through interrupt delivery (GC never
  // runs ME-less; msr=0 is fatal). The dolphin-executor intermittently drops ME
  // pre-takeover (the documented ME-drop, powerpc-next msr-handling — separate audit);
  // delivery from an 0x8032-class context then computed msr=0x0000 and wedged the
  // post-takeover guest. Make the mutation robust: ME survives delivery uncondionally.
  m_ppc_state.msr.Hex |= 0x1000;
#endif
      m_ppc_state.pc = m_ppc_state.npc = 0x00000500;
#ifdef __EMSCRIPTEN__
      // [deliv-gen MONOTONIC 2026-07-09 — FUNCTIONAL] Bump the delivery generation at
      // SAB 0x026B0970 so the worker's deliv-reconcile (ppc_worker.js) adopts this
      // 0x500 redirect before its next dispatch. Load-bearing dual-core coordination.
      {
        volatile u32* const hd = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B0970u));
        *hd = *hd + 1u;
      }
#endif

      DEBUG_LOG_FMT(POWERPC, "EXCEPTION_EXTERNAL_INT");
#ifdef __EMSCRIPTEN__
      // [aram-diag 2026-07-22 TEMP] EXT delivery commits @0x026B1BC8; commits with the DSP
      // bit live in the PI cause @0x026B1BC4 (pair with cause-set/clear @0x026B1BC0/1BCC).
      {
        volatile u32* t = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1BC8u));
        *t = *t + 1u;
        if ((m_system.GetProcessorInterface().m_interrupt_cause & 0x00000040u) != 0u)
        {
          volatile u32* d = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1BC4u));
          *d = *d + 1u;
        }
      }
#endif
      m_ppc_state.Exceptions &= ~EXCEPTION_EXTERNAL_INT;

      DEBUG_ASSERT_MSG(POWERPC, (SRR1(m_ppc_state) & 0x02) != 0, "EXTERNAL_INT unrecoverable???");
    }
    else if (exceptions & EXCEPTION_PERFORMANCE_MONITOR)
    {
      SRR0(m_ppc_state) = m_ppc_state.npc;
      SRR1(m_ppc_state) = m_ppc_state.msr.Hex & 0x87C0FFFF;
      m_ppc_state.msr.LE = m_ppc_state.msr.ILE;
      m_ppc_state.msr.Hex &= ~0x04EF36;
#ifdef __EMSCRIPTEN__
  // [me-preserve 2026-07-07] real HW keeps ME set through interrupt delivery (GC never
  // runs ME-less; msr=0 is fatal). The dolphin-executor intermittently drops ME
  // pre-takeover (the documented ME-drop, powerpc-next msr-handling — separate audit);
  // delivery from an 0x8032-class context then computed msr=0x0000 and wedged the
  // post-takeover guest. Make the mutation robust: ME survives delivery uncondionally.
  m_ppc_state.msr.Hex |= 0x1000;
#endif
      m_ppc_state.pc = m_ppc_state.npc = 0x00000F00;

      DEBUG_LOG_FMT(POWERPC, "EXCEPTION_PERFORMANCE_MONITOR");
      m_ppc_state.Exceptions &= ~EXCEPTION_PERFORMANCE_MONITOR;
    }
    else if (exceptions & EXCEPTION_DECREMENTER)
    {
#if defined(__EMSCRIPTEN__)
      if (m_ppc_state.npc != m_ppc_state.pc)
        m_ppc_state.npc = m_ppc_state.pc;
#endif
#ifdef __EMSCRIPTEN__
      // [ee-gate, DEC arm — Step 2] same enforcement + same PLACEMENT FIX as the EXT arm:
      // refuse BEFORE touching SRR0/SRR1.
      if (!m_ppc_state.msr.EE)
      {
        return;
      }
      // [gate #3, DEC arm — 2026-07-10 PERMANENT] Same rationale as the EXT arm's gate:
      // never write SRR0/SRR1 while pc is inside an exception stub. The DEC arm was the
      // one delivery arm WITHOUT it — a DEC delivered at pc=0x500 (npc-sync'd) saved
      // SRR0=0x500; the DEC ISR's rfi then returned INTO the stub with EE=1, the stub
      // re-ran as normal code, and the guest orbited 0x500<->0x900 forever = the 0x500
      // re-delivery storm face (pcring all-500 at ~3.9K/s, VI+DSP causes never acked,
      // wFrames frozen at the armframe). Deferred, not dropped: the bit stays pending
      // and delivers at the next boundary with pc outside the stubs.
      if (m_ppc_state.pc < 0x4000u)
        return;
#endif
      SRR0(m_ppc_state) = m_ppc_state.npc;
      SRR1(m_ppc_state) = m_ppc_state.msr.Hex & 0x87C0FFFF;
      m_ppc_state.msr.LE = m_ppc_state.msr.ILE;
      m_ppc_state.msr.Hex &= ~0x04EF36;
#ifdef __EMSCRIPTEN__
  // [me-preserve 2026-07-07] real HW keeps ME set through interrupt delivery (GC never
  // runs ME-less; msr=0 is fatal). The dolphin-executor intermittently drops ME
  // pre-takeover (the documented ME-drop, powerpc-next msr-handling — separate audit);
  // delivery from an 0x8032-class context then computed msr=0x0000 and wedged the
  // post-takeover guest. Make the mutation robust: ME survives delivery uncondionally.
  m_ppc_state.msr.Hex |= 0x1000;
#endif
      m_ppc_state.pc = m_ppc_state.npc = 0x00000900;
#ifdef __EMSCRIPTEN__
      // [deliv-gen MONOTONIC 2026-07-09 — FUNCTIONAL] Bump the delivery generation at
      // SAB 0x026B0970 so the worker's deliv-reconcile adopts this 0x900 (DEC) redirect
      // before its next dispatch (un-adopted stale cursor = the 0x900-stub clobber race).
      {
        volatile u32* const hd = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B0970u));
        *hd = *hd + 1u;
      }
#endif

      DEBUG_LOG_FMT(POWERPC, "EXCEPTION_DECREMENTER");
      m_ppc_state.Exceptions &= ~EXCEPTION_DECREMENTER;
    }
    else
    {
      DEBUG_ASSERT_MSG(POWERPC, 0, "Unknown EXT interrupt: Exceptions == {:08x}", exceptions);
      ERROR_LOG_FMT(POWERPC, "Unknown EXTERNAL INTERRUPT exception: Exceptions == {:08x}",
                    exceptions);
    }
    MSRUpdated();
  }
}

bool PowerPCManager::CheckBreakPoints()
{
  const TBreakPoint* bp = m_breakpoints.GetBreakpoint(m_ppc_state.pc);

  if (!m_breakpoints.IsBreakingEnabled() || !bp || !bp->is_enabled ||
      !EvaluateCondition(m_system, bp->condition))
    return false;

  if (bp->log_on_hit)
  {
    NOTICE_LOG_FMT(MEMMAP,
                   "BP {:08x} {}({:08x} {:08x} {:08x} {:08x} {:08x} {:08x} {:08x} {:08x} {:08x} "
                   "{:08x}) LR={:08x}",
                   m_ppc_state.pc, m_symbol_db.GetDescription(m_ppc_state.pc), m_ppc_state.gpr[3],
                   m_ppc_state.gpr[4], m_ppc_state.gpr[5], m_ppc_state.gpr[6], m_ppc_state.gpr[7],
                   m_ppc_state.gpr[8], m_ppc_state.gpr[9], m_ppc_state.gpr[10], m_ppc_state.gpr[11],
                   m_ppc_state.gpr[12], LR(m_ppc_state));
  }
  if (bp->break_on_hit)
    return true;
  return false;
}

bool PowerPCManager::CheckAndHandleBreakPoints()
{
  if (CheckBreakPoints())
  {
    m_system.GetCPU().Break();
    if (GDBStub::IsActive())
      GDBStub::TakeControl();
    return true;
  }
  return false;
}

void PowerPCManager::MSRUpdated()
{
  static_assert(UReg_MSR{}.DR.StartBit() == 4);
  static_assert(UReg_MSR{}.IR.StartBit() == 5);
  static_assert(FEATURE_FLAG_MSR_DR == 1 << 0);
  static_assert(FEATURE_FLAG_MSR_IR == 1 << 1);

  m_ppc_state.feature_flags = static_cast<CPUEmuFeatureFlags>(
      (m_ppc_state.feature_flags & FEATURE_FLAG_PERFMON) | ((m_ppc_state.msr.Hex >> 4) & 0x3));

  if (m_ppc_state.msr.DR && m_ppc_state.pagetable_update_pending)
    m_system.GetMMU().PageTableUpdated();

  m_system.GetJitInterface().UpdateMembase();
}

// FPSCR update functions

void PowerPCState::UpdateFPRFDouble(double dvalue)
{
  fpscr.FPRF = Common::ClassifyDouble(dvalue);
}

void PowerPCState::UpdateFPRFSingle(float fvalue)
{
  fpscr.FPRF = Common::ClassifyFloat(fvalue);
}

void RoundingModeUpdated(PowerPCState& ppc_state)
{
  // The rounding mode is separate for each thread, so this must run on the CPU thread
  ASSERT(Core::IsCPUThread());

  Common::FPU::SetSIMDMode(ppc_state.fpscr.RN, ppc_state.fpscr.NI);
}

void MMCRUpdated(PowerPCState& ppc_state)
{
  const bool perfmon = ppc_state.spr[SPR_MMCR0] || ppc_state.spr[SPR_MMCR1];
  ppc_state.feature_flags = static_cast<CPUEmuFeatureFlags>(
      (ppc_state.feature_flags & ~FEATURE_FLAG_PERFMON) | (perfmon ? FEATURE_FLAG_PERFMON : 0));
}

void RecalculateAllFeatureFlags(PowerPCState& ppc_state)
{
  static_assert(UReg_MSR{}.DR.StartBit() == 4);
  static_assert(UReg_MSR{}.IR.StartBit() == 5);
  static_assert(FEATURE_FLAG_MSR_DR == 1 << 0);
  static_assert(FEATURE_FLAG_MSR_IR == 1 << 1);

  const bool perfmon = ppc_state.spr[SPR_MMCR0] || ppc_state.spr[SPR_MMCR1];
  ppc_state.feature_flags = static_cast<CPUEmuFeatureFlags>(((ppc_state.msr.Hex >> 4) & 0x3) |
                                                            (perfmon ? FEATURE_FLAG_PERFMON : 0));
}

void CheckExceptionsFromJIT(PowerPCManager& power_pc)
{
  power_pc.CheckExceptions();
}

void CheckExternalExceptionsFromJIT(PowerPCManager& power_pc)
{
  power_pc.CheckExternalExceptions();
}

void CheckAndHandleBreakPointsFromJIT(PowerPCManager& power_pc)
{
  power_pc.CheckAndHandleBreakPoints();
}
}  // namespace PowerPC
