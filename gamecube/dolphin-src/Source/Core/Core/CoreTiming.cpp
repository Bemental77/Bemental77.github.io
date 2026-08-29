// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "Core/CoreTiming.h"

// [throttle-sizing TEMP 2026-08-07 — set to 0 to disable; gated one-shot for the
// track-2 step-0 sizing, remove after. Splits throttle sleep by finish-inflight.]
#define BEM_THROTTLE_SIZING 0
#if defined(__EMSCRIPTEN__) && BEM_THROTTLE_SIZING
#include <emscripten.h>
#endif

#include <algorithm>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include <fmt/format.h>

#include "Common/Assert.h"
#include "Common/ChunkFile.h"
#include "Common/Logging/Log.h"
#include "Common/SPSCQueue.h"
#include "Common/ScopeGuard.h"

#include "Core/AchievementManager.h"
#include "Core/CPUThreadConfigCallback.h"
#include "Core/Config/MainSettings.h"
#include "Core/Core.h"
#include "Core/HW/SystemTimers.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"

#include "VideoCommon/Fifo.h"
#include "VideoCommon/OnScreenDisplay.h"
#include "VideoCommon/PerformanceMetrics.h"
#include "VideoCommon/VideoBackendBase.h"

#include "VideoCommon/VideoConfig.h"
#include "VideoCommon/VideoEvents.h"

namespace CoreTiming
{
static constexpr int MAX_SLICE_LENGTH = 20000;

static void EmptyTimedCallback(Core::System& system, u64 userdata, s64 cyclesLate)
{
}

CoreTimingManager::CoreTimingManager(Core::System& system) : m_system(system)
{
}

// Changing the CPU speed in Dolphin isn't actually done by changing the physical clock rate,
// but by changing the amount of work done in a particular amount of time. This tends to be more
// compatible because it stops the games from actually knowing directly that the clock rate has
// changed, and ensures that anything based on waiting a specific number of cycles still works.
//
// Technically it might be more accurate to call this changing the IPC instead of the CPU speed,
// but the effect is largely the same.
int CoreTimingManager::DowncountToCycles(int downcount) const
{
  return static_cast<int>(downcount * m_globals.last_OC_factor_inverted);
}

int CoreTimingManager::CyclesToDowncount(int cycles) const
{
  return static_cast<int>(cycles * m_last_oc_factor);
}

EventType* CoreTimingManager::RegisterEvent(const std::string& name, TimedCallback callback)
{
  // check for existing type with same name.
  // we want event type names to remain unique so that we can use them for serialization.
  ASSERT_MSG(POWERPC, !m_event_types.contains(name),
             "CoreTiming Event \"{}\" is already registered. Events should only be registered "
             "during Init to avoid breaking save states.",
             name);

  auto info = m_event_types.emplace(name, EventType{callback, nullptr});
  EventType* event_type = &info.first->second;
  event_type->name = &info.first->first;
  return event_type;
}

void CoreTimingManager::UnregisterAllEvents()
{
  ASSERT_MSG(POWERPC, m_event_queue.empty(), "Cannot unregister events with events pending");
  m_event_types.clear();
}

void CoreTimingManager::Init()
{
  m_system.GetPPCState().downcount = CyclesToDowncount(MAX_SLICE_LENGTH);
  m_globals.slice_length = MAX_SLICE_LENGTH;
  m_globals.global_timer = 0;
  m_idled_cycles = 0;

  // The time between CoreTiming being initialized and the first call to Advance() is considered
  // the slice boundary between slice -1 and slice 0. Dispatcher loops must call Advance() before
  // executing the first PPC cycle of each slice to prepare the slice length and downcount for
  // that slice.
  m_is_global_timer_sane = true;

  // Reset data used by the throttling system
  ResetThrottle(0);

  m_event_fifo_id = 0;
  m_ev_lost = RegisterEvent("_lost_event", &EmptyTimedCallback);

  m_registered_config_callback_id =
      CPUThreadConfigCallback::AddConfigChangedCallback([this]() { RefreshConfig(); });
  RefreshConfig();

  m_last_oc_factor = m_config_oc_factor;
  m_globals.last_OC_factor_inverted = m_config_oc_inv_factor;

  m_core_state_changed_hook = Core::AddOnStateChangedCallback([this](Core::State state) {
    if (state == Core::State::Running)
    {
      // We don't want Throttle to attempt catch-up for all the time lost while paused.
      ResetThrottle(GetTicks());
    }
  });

  m_throttled_after_presentation = false;
  m_frame_hook = m_system.GetVideoEvents().after_present_event.Register([this](const PresentInfo&) {
    m_throttled_after_presentation.store(false, std::memory_order_relaxed);
  });
}

void CoreTimingManager::Shutdown()
{
  m_core_state_changed_hook.reset();

  std::lock_guard lk(m_ts_write_lock);
  MoveEvents();
  ClearPendingEvents();
  UnregisterAllEvents();
  CPUThreadConfigCallback::RemoveConfigChangedCallback(m_registered_config_callback_id);
  m_frame_hook.reset();
}

void CoreTimingManager::RefreshConfig()
{
  m_config_oc_factor =
      (Config::Get(Config::MAIN_OVERCLOCK_ENABLE) ? Config::Get(Config::MAIN_OVERCLOCK) : 1.0f) *
      (Config::Get(Config::MAIN_VI_OVERCLOCK_ENABLE) ? Config::Get(Config::MAIN_VI_OVERCLOCK) :
                                                       1.0f);
  m_config_oc_inv_factor = 1.0f / m_config_oc_factor;
  m_config_sync_on_skip_idle = Config::Get(Config::MAIN_SYNC_ON_SKIP_IDLE);
  m_config_rush_frame_presentation = Config::Get(Config::MAIN_RUSH_FRAME_PRESENTATION);

  // We don't want to skip so much throttling that the audio buffer overfills.
  m_max_throttle_skip_time =
      std::chrono::milliseconds{Config::Get(Config::MAIN_AUDIO_BUFFER_SIZE)} / 2;

  // A maximum fallback is used to prevent the system from sleeping for
  // too long or going full speed in an attempt to catch up to timings.
  m_max_fallback = std::chrono::duration_cast<DT>(DT_ms(Config::Get(Config::MAIN_MAX_FALLBACK)));

  m_max_variance = std::chrono::duration_cast<DT>(DT_ms(Config::Get(Config::MAIN_TIMING_VARIANCE)));

  m_correct_time_drift = Config::Get(Config::MAIN_CORRECT_TIME_DRIFT);

  if (AchievementManager::GetInstance().IsHardcoreModeActive() &&
      Config::Get(Config::MAIN_EMULATION_SPEED) < 1.0f &&
      Config::Get(Config::MAIN_EMULATION_SPEED) > 0.0f)
  {
    Config::SetCurrent(Config::MAIN_EMULATION_SPEED, 1.0f);
    OSD::AddMessage("Minimum speed is 100% in Hardcore Mode");
  }

  UpdateSpeedLimit(GetTicks(), Config::Get(Config::MAIN_EMULATION_SPEED));

  m_use_precision_timer = Config::Get(Config::MAIN_PRECISION_FRAME_TIMING);
}

void CoreTimingManager::DoState(PointerWrap& p)
{
  std::lock_guard lk(m_ts_write_lock);
  p.Do(m_globals.slice_length);
  p.Do(m_globals.global_timer);
  p.Do(m_idled_cycles);
  p.Do(m_fake_dec_start_value);
  p.Do(m_fake_dec_start_ticks);
  p.Do(m_globals.fake_TB_start_value);
  p.Do(m_globals.fake_TB_start_ticks);
  p.Do(m_last_oc_factor);
  m_globals.last_OC_factor_inverted = 1.0f / m_last_oc_factor;
  p.Do(m_event_fifo_id);

  p.DoMarker("CoreTimingData");

  MoveEvents();
  p.DoEachElement(m_event_queue, [this](PointerWrap& pw, Event& ev) {
    pw.Do(ev.time);
    pw.Do(ev.fifo_order);

    // this is why we can't have (nice things) pointers as userdata
    pw.Do(ev.userdata);

    // we can't savestate ev.type directly because events might not get registered in the same
    // order (or at all) every time.
    // so, we savestate the event's type's name, and derive ev.type from that when loading.
    std::string name;
    if (!pw.IsReadMode())
      name = *ev.type->name;

    pw.Do(name);
    if (pw.IsReadMode())
    {
      auto itr = m_event_types.find(name);
      if (itr != m_event_types.end())
      {
        ev.type = &itr->second;
      }
      else
      {
        WARN_LOG_FMT(POWERPC,
                     "Lost event from savestate because its type, \"{}\", has not been registered.",
                     name);
        ev.type = m_ev_lost;
      }
    }
  });
  p.DoMarker("CoreTimingEvents");

  if (p.IsReadMode())
  {
    // When loading from a save state, we must assume the Event order is random and meaningless.
    // The exact layout of the heap in memory is implementation defined, therefore it is platform
    // and library version specific.
    std::ranges::make_heap(m_event_queue, std::ranges::greater{});

    // The stave state has changed the time, so our previous Throttle targets are invalid.
    // Especially when global_time goes down; So we create a fake throttle update.
    ResetThrottle(m_globals.global_timer);
  }
}

// This should only be called from the CPU thread. If you are calling
// it from any other thread, you are doing something evil
u64 CoreTimingManager::GetTicks() const
{
  u64 ticks = static_cast<u64>(m_globals.global_timer);
  if (!m_is_global_timer_sane)
  {
    int downcount = DowncountToCycles(m_system.GetPPCState().downcount);
    ticks += m_globals.slice_length - downcount;
  }
  return ticks;
}

u64 CoreTimingManager::GetIdleTicks() const
{
  return static_cast<u64>(m_idled_cycles);
}

void CoreTimingManager::ClearPendingEvents()
{
  m_event_queue.clear();
}

void CoreTimingManager::ScheduleEvent(s64 cycles_into_future, EventType* event_type, u64 userdata,
                                      FromThread from)
{
  ASSERT_MSG(POWERPC, event_type, "Event type is nullptr, will crash now.");

  bool from_cpu_thread;
  if (from == FromThread::ANY)
  {
    from_cpu_thread = Core::IsCPUThread();
  }
  else
  {
    from_cpu_thread = from == FromThread::CPU;
    ASSERT_MSG(POWERPC, from_cpu_thread == Core::IsCPUThread(),
               "A \"{}\" event was scheduled from the wrong thread ({})", *event_type->name,
               from_cpu_thread ? "CPU" : "non-CPU");
  }

  if (from_cpu_thread)
  {
    s64 timeout = GetTicks() + cycles_into_future;

    // If this event needs to be scheduled before the next advance(), force one early
    if (!m_is_global_timer_sane)
      ForceExceptionCheck(cycles_into_future);

    m_event_queue.emplace_back(Event{timeout, m_event_fifo_id++, userdata, event_type});
    std::ranges::push_heap(m_event_queue, std::ranges::greater{});
  }
  else
  {
    if (Core::WantsDeterminism())
    {
      ERROR_LOG_FMT(POWERPC,
                    "Someone scheduled an off-thread \"{}\" event while netplay or "
                    "movie play/record was active.  This is likely to cause a desync.",
                    *event_type->name);
    }

    std::lock_guard lk(m_ts_write_lock);
    m_ts_queue.Push(Event{cycles_into_future, 0, userdata, event_type});
  }
}

void CoreTimingManager::RemoveEvent(EventType* event_type)
{
  const size_t erased =
      std::erase_if(m_event_queue, [&](const Event& e) { return e.type == event_type; });

  // Removing random items breaks the invariant so we have to re-establish it.
  if (erased != 0)
  {
    std::ranges::make_heap(m_event_queue, std::ranges::greater{});
  }
}

void CoreTimingManager::RemoveAllEvents(EventType* event_type)
{
  MoveEvents();
  RemoveEvent(event_type);
}

void CoreTimingManager::ForceExceptionCheck(s64 cycles)
{
  cycles = std::max<s64>(0, cycles);
  auto& ppc_state = m_system.GetPPCState();
  if (DowncountToCycles(ppc_state.downcount) > cycles)
  {
    // downcount is always (much) smaller than MAX_INT so we can safely cast cycles to an int here.
    // Account for cycles already executed by adjusting the m_globals.slice_length
    m_globals.slice_length -= DowncountToCycles(ppc_state.downcount) - static_cast<int>(cycles);
    ppc_state.downcount = CyclesToDowncount(static_cast<int>(cycles));
  }
}

void CoreTimingManager::MoveEvents()
{
  while (!m_ts_queue.Empty())
  {
    auto& ev = m_event_queue.emplace_back(m_ts_queue.Front());
    m_ts_queue.Pop();

    ev.fifo_order = m_event_fifo_id++;
    ev.time += m_globals.global_timer;

    std::ranges::push_heap(m_event_queue, std::ranges::greater{});
  }
}

void CoreTimingManager::RebaseTime(s64 delta)
{
  m_globals.global_timer += delta;
  for (auto& evt : m_event_queue)
    evt.time += delta;
}

void CoreTimingManager::Advance()
{
  CPUThreadConfigCallback::CheckForConfigChanges();

  MoveEvents();

  auto& power_pc = m_system.GetPowerPC();
  auto& ppc_state = power_pc.GetPPCState();

#ifdef __EMSCRIPTEN__
  // [fire-only advance 2026-07-03 — THE aramStoreData boot gate] While the ppc-worker owns
  // the CPU (cpu_owner @0x026A0000 == 1), Advance runs in FIRE-ONLY mode: credit no cycles
  // (the worker advances global_timer via its own commit path) and leave downcount/
  // slice_length alone (the worker's live countdown must not be clobbered mid-slice). This
  // lets sim-time completions (ARAM-DMA/ARQ, DSP, VI) fire WHILE the worker executes —
  // previously Advance only ran in dolphin's exclusive yield window (~2/s), so each of the
  // ~1000 audio-upload chunks waited ~0.5s for its DMA-complete event: MP4 ground forever in
  // aramStoreData (pc-histo: 3.6M+3.6M hits at +0x48/+0x1b4 over 5min, wipeData never
  // written). Delivery stays single-owner per the [ee-race fix] below.
  const bool worker_owns_cpu =
      (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u) &&
      (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0008u)) == 0u);
  // ^ 0x026A0008 = ff-excursion flag: inside the idle fast-forward the dc=0 full-slice
  //   credit IS the mechanism that crosses event gaps — grant normal credit there.
  int cyclesExecuted =
      worker_owns_cpu ? 0 : m_globals.slice_length - DowncountToCycles(ppc_state.downcount);
  // [gt-monotonic 2026-07-08 fix-a] never rewind: a negative cyclesExecuted (downcount >
  // slice_length, seen worker_owns=0, ~-19000) would decrement global_timer. Clamp to 0 so
  // the clock only advances — restores native Dolphin's global_timer-only-increments invariant.
  if (cyclesExecuted < 0)
    cyclesExecuted = 0;
#else
  int cyclesExecuted = m_globals.slice_length - DowncountToCycles(ppc_state.downcount);
#endif
  m_globals.global_timer += cyclesExecuted;
#ifdef __EMSCRIPTEN__
  // [MIPS meter 2026-08-11] Mirror the EmuThread's CREDITED emulated clock to
  // dedicated meter cells (0x026B3424 lo / 0x026B3428 hi). The existing
  // 0x02680008/0C mirror is written only on the device FfAdvanceTo catch-up
  // path (stale during steady gameplay), so the meter needs its own. This is
  // the total emulated cycles (real charges + idle-skip phantom); executed
  // (0x026B3420) subtracted from this = phantom credit.
  {
    const u64 bem_gt = static_cast<u64>(m_globals.global_timer);
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3424u)) =
        static_cast<u32>(bem_gt & 0xFFFFFFFFu);
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3428u)) =
        static_cast<u32>((bem_gt >> 32) & 0xFFFFFFFFu);
  }
  // [gt-adopt 2026-07-06 — the post-takeover finish line] Fire-only mode credits 0 cycles
  // on the assumption that "the worker advances global_timer via its own commit path" —
  // but those commits land in the WORKER's ct mirror (SAB 0x02680008/0C), never here, so
  // m_globals.global_timer froze at the handover point and NO event ever came due
  // (measured: worker idle-jumps Δ2.1B ticks, ct-track events=0, VI never fires,
  // VIWaitForRetrace spins forever at retired=137M). Adopt the worker's published time
  // monotonically so due events (VI retrace, DSP, AI) fire against real sim-time.
  if (worker_owns_cpu)
  {
    // [determinism 2026-07-17 — seqlock the gt-adopt READ] The worker publishes the split-64
    // global_timer (0x02680008/0C) under a seqlock at CT header +0x14 (odd during a write). A
    // plain 32+32 read here can observe a torn (new_lo,old_hi) value up to 4.29e9 ticks off,
    // which the monotonic-max at :417 can PERMANENTLY LATCH — fast-forwarding dolphin forever
    // and starving every future event. Retry-read under the same seqlock the writer honors so a
    // torn value can never reach the max(). (rank-2 nondeterminism source.)
    u32 wlo = 0u, whi = 0u;
    {
      volatile u32* const p_seq =
          reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x02680000u + 0x14u));
      volatile u32* const p_lo =
          reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x02680008u));
      volatile u32* const p_hi =
          reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x0268000Cu));
      for (int attempt = 0; attempt < 4; ++attempt)
      {
        const u32 s0 = __atomic_load_n(p_seq, __ATOMIC_ACQUIRE);
        if (s0 & 1u)
          continue;  // writer mid-update
        wlo = *p_lo;
        whi = *p_hi;
        const u32 s1 = __atomic_load_n(p_seq, __ATOMIC_ACQUIRE);
        if (s1 == s0)
          break;  // stable snapshot
      }
    }
    const u64 wgt = static_cast<u64>(wlo) | (static_cast<u64>(whi) << 32);
    // [one-clock 2026-07-07] EXACT assignment (was max()): one-way-up adoption let the
    // ff excursion's full-slice credits INFLATE this timer above honest worker time —
    // adoption then never lifted again, the timer froze, and every queued event hung
    // above it (evFired froze; the deep-ISR DSP-mailbox poll starved). The worker's
    // smooth-paced cells are THE clock; this timer follows exactly. The takeover-edge
    // RebaseTime shifts pre-existing events into the unified domain.
    if (wgt != 0u)
    {
      const s64 wsigned = static_cast<s64>(wgt);
      // [gt-monotonic 2026-07-08 fix-a] ONLY ADVANCE. The worker's published gt can transiently
      // LAG dolphin's (dolphin over-advanced via an excursion, wgt < current by ~one slice) —
      // adopting it exactly REWOUND the clock (measured -20001) and killed CoreTiming events.
      // Follow the worker UP only; never backward. (The takeover-edge RebaseTime still does the
      // one intentional reset into the unified domain.)
      if (wsigned > m_globals.global_timer)
        m_globals.global_timer = wsigned;
    }
  }
#endif
  m_last_oc_factor = m_config_oc_factor;
  m_globals.last_OC_factor_inverted = m_config_oc_inv_factor;
#ifdef __EMSCRIPTEN__
  if (!worker_owns_cpu)
#endif
  m_globals.slice_length = MAX_SLICE_LENGTH;

  m_is_global_timer_sane = true;

  while (!m_event_queue.empty() && m_event_queue.front().time <= m_globals.global_timer)
  {
    Event evt = std::move(m_event_queue.front());
    std::ranges::pop_heap(m_event_queue, std::ranges::greater{});
    m_event_queue.pop_back();
    evt.type->callback(m_system, evt.userdata, m_globals.global_timer - evt.time);
  }

  m_is_global_timer_sane = false;

  // Still events left (scheduled in the future)
  if (!m_event_queue.empty())
  {
    m_globals.slice_length = static_cast<int>(
        std::min<s64>(m_event_queue.front().time - m_globals.global_timer, MAX_SLICE_LENGTH));
  }
#ifdef __EMSCRIPTEN__
  // [ct-next publish 2026-07-03] Expose the HYBRID queue's next-event time so the worker's
  // sleep-tick can jump sim-time to VI/ARAM/DSP events. The worker's own CT mirror holds
  // only its pure events — dolphin's queue was invisible, so idle spins burned real slices
  // toward every VI (measured: frames capped ~156/300s with 1.5B retired). Layout:
  // 0x026B0910 = lo, 0x026B0914 = hi, 0x026B0918 = valid flag (0 when queue empty).
  {
    volatile u32* const cell =
        reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B0910u));
    if (!m_event_queue.empty())
    {
      const u64 t = static_cast<u64>(m_event_queue.front().time);
      cell[0] = static_cast<u32>(t & 0xFFFFFFFFu);
      cell[1] = static_cast<u32>(t >> 32);
      cell[2] = 1u;
    }
    else
    {
      cell[2] = 0u;
    }
  }
#endif

#ifdef __EMSCRIPTEN__
  if (!worker_owns_cpu)  // [fire-only advance] never clobber the worker's live countdown
#endif
  ppc_state.downcount = CyclesToDowncount(m_globals.slice_length);

  // Check for any external exceptions.
  // It's important to do this after processing events otherwise any exceptions will be delayed
  // until the next slice:
  //        Pokemon Box refuses to boot if the first exception from the audio DMA is received late
#ifdef __EMSCRIPTEN__
  // [ee-race fix 2026-07-02] SINGLE-OWNER DELIVERY. When the ppc-worker owns the
  // CPU (cpu_owner @ SAB 0x026A0000 == 1), dolphin's excursion must still FIRE
  // events above (hybrid VI/DSP/AI fire only here — the worker's
  // ct_fire_due_pure ignores hybrids without CT_PHASE3_ENABLE), but must NOT
  // vector: this call races the worker's concurrent guest execution on the
  // SHARED ppc_state — the PowerPC.cpp:671 msr.EE gate is TOCTOU across
  // executors (gate reads EE=1, worker's guest reaches EE=0, SRR0=stale npc /
  // SRR1=EE-0 MSR / PC=0x500 land mid-block). Observed as a nested
  // __OSDispatchInterrupt (SRR1.EE=0): a second VI-retrace handler chain on the
  // SAME interrupt-stack base as the live first one, whose PADRead data[2]
  // write trampled SIGetType's saved-callback slot (0x8019d3e4 -> 0x808080 SI
  // crash). Pending bits stay set; the worker delivers them via its own
  // EE-gated cmd-10 path (worker parked during service — no race).
  if (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u)
    return;
#endif
  power_pc.CheckExternalExceptions();
}

#ifdef __EMSCRIPTEN__
s64 CoreTimingManager::FirstEventTime() const
{
  return m_event_queue.empty() ? static_cast<s64>(-1) : m_event_queue.front().time;
}

s64 CoreTimingManager::FfAdvanceTo(s64 target)
{
  // [determinism 2026-07-17] Deterministic idle-gap cross. Set global_timer to an EXACT
  // caller-supplied target and fire every due hybrid event in ONE step — replaces the ff
  // excursion's race-terminated 1024-burst whose trip count was set by concurrently-mutated
  // *exc/*pc_live reads (rank-1 nondeterminism). Fires ONLY dolphin's hybrid queue; pure/DEC
  // events stay the CPU worker's. Mirrors Advance's event-drain + slice_length + hybrid-head
  // publish, minus cyclesExecuted/gt-adopt/CheckExternalExceptions (single-owner delivery).
  if (target <= m_globals.global_timer)
    return m_globals.global_timer;
  m_globals.global_timer = target;
  m_is_global_timer_sane = true;
  while (!m_event_queue.empty() && m_event_queue.front().time <= m_globals.global_timer)
  {
    Event evt = std::move(m_event_queue.front());
    std::ranges::pop_heap(m_event_queue, std::ranges::greater{});
    m_event_queue.pop_back();
    evt.type->callback(m_system, evt.userdata, m_globals.global_timer - evt.time);
  }
  m_is_global_timer_sane = false;
  volatile u32* const cell =
      reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B0910u));
  if (!m_event_queue.empty())
  {
    m_globals.slice_length = static_cast<int>(
        std::min<s64>(m_event_queue.front().time - m_globals.global_timer, MAX_SLICE_LENGTH));
    const u64 t = static_cast<u64>(m_event_queue.front().time);
    cell[0] = static_cast<u32>(t & 0xFFFFFFFFu);
    cell[1] = static_cast<u32>(t >> 32);
    cell[2] = 1u;
  }
  else
  {
    cell[2] = 0u;
  }
  return m_globals.global_timer;
}
#endif

TimePoint CoreTimingManager::CalculateTargetHostTimeInternal(s64 target_cycle)
{
  const s64 elapsed_cycles = target_cycle - m_throttle_reference_cycle;
  return m_throttle_reference_time +
         Clock::duration{std::chrono::seconds{elapsed_cycles}} / m_throttle_adj_clock_per_sec;
}

#if defined(__EMSCRIPTEN__)
// [uncap-probe 2026-08-28] Runtime uncap switch, DEFAULT-OFF, by SAB scratch cell
// (never getenv — dead cross-thread; see gc_runtime_flags_via_sab_cell_not_env).
//
// WHY THIS EXISTS: the only two routes to an unlimited core are
// Config::MAIN_EMULATION_SPEED (Boot.cpp:313 reads the libretro option
// `dolphin_emulation_speed`) and Core::SetIsThrottlerTempDisabled (Boot.cpp:592,
// pinned false under Emscripten). But EmscriptenWorker.cpp's environment_cb
// (:137) handles NO RETRO_ENVIRONMENT_GET_VARIABLE case at all, so every
// GetOption call falls back to its table default — "1.0". The throttle is
// therefore UNCONDITIONAL in this build and the "uncapped ceiling" cannot be
// observed without this cell.
//
// Cell 0 (the default) makes IsSpeedUnlimited byte-identical to before.
// Boot.cpp:305-311 documents why unlimited must NOT be on during boot (the
// freed EmuThread races emulated time -> MusyX DSP/AID service storm, MP4 init
// starves at gc=0), so the page/probe must set this only in steady state.
// [CELL MOVED 2026-08-29 — 0x026B3D10 WAS INSIDE THE FPR SPILL WINDOW.]
// powerpc-next's FPR register cache spills v128s to `0x026B3C00 + preg*16` for 32
// pregs (fpr_reg_cache.cpp:335,367,385; ppc_emit.cpp:1149), i.e. the window
// 0x026B3C00..0x026B3DFF. 0x026B3D10 == 0x026B3C00 + 272 == preg 17's slot, and
// JitWasm.cpp:62 includes powerpc-next's ppc_emit.h, so that emitter is the LIVE
// path in the dolphin worker. Since ANY nonzero value uncaps (see below), a float
// spill of f17 carrying nonzero bits would silently uncap the emulator — running
// the GUEST fast, which is the one thing we are forbidden to do, with no log and
// no visible cause. Observed `before=0` at the flip in 3/3 uncap arms so it did
// not fire in that workload, but the overlap is arithmetic, not opinion.
// 0x026B392C is above the witness cells (0x026B3918..0x026B3928) and below the
// FPR window; a repo-wide grep for it returns zero hits.
static constexpr uintptr_t kBemUncapCell = 0x026B392Cu;  // 0 = throttled (default)
#endif

bool CoreTimingManager::IsSpeedUnlimited() const
{
#if defined(__EMSCRIPTEN__)
  if (*reinterpret_cast<volatile u32*>(kBemUncapCell) != 0u)
    return true;
#endif
  return m_throttle_adj_clock_per_sec == 0 || Core::GetIsThrottlerTempDisabled();
}

TimePoint CoreTimingManager::GetTargetHostTime(s64 target_cycle)
{
  if (IsSpeedUnlimited())
    return Clock::now();

  return CalculateTargetHostTimeInternal(target_cycle);
}

void CoreTimingManager::SleepUntil(TimePoint time_point)
{
  const bool use_precision_timer = m_use_precision_timer.load(std::memory_order_relaxed);

  if (Core::IsCPUThread())
  {
    const TimePoint time = Clock::now();

    if (use_precision_timer)
      m_precision_cpu_timer.SleepUntil(time_point);
    else
      std::this_thread::sleep_until(time_point);

    // Count amount of time sleeping for analytics
    const TimePoint time_after_sleep = Clock::now();
    g_perf_metrics.CountThrottleSleep(time_after_sleep - time);
  }
  else
  {
    if (use_precision_timer)
      m_precision_gpu_timer.SleepUntil(time_point);
    else
      std::this_thread::sleep_until(time_point);
  }
}

void CoreTimingManager::Throttle(const s64 target_cycle)
{
  const TimePoint time = Clock::now();

  const bool already_throttled =
      m_throttled_after_presentation.exchange(true, std::memory_order_relaxed);

  // If RushFramePresentation is enabled, try to Throttle just once after each presentation.
  //  This lowers input latency by speeding through to presentation after grabbing input.
  // Make sure we don't get too far ahead of proper timing though,
  //  otherwise the emulator unreasonably speeds through loading screens that don't have XFB copies,
  //  making audio sound terrible.
  const bool skip_throttle = already_throttled && m_config_rush_frame_presentation &&
                             ((GetTargetHostTime(target_cycle) - time) < m_max_throttle_skip_time);
  if (skip_throttle)
    return;

  // Measure current performance after throttling.
  Common::ScopeGuard perf_marker{[&] {
    g_perf_metrics.CountPerformanceMarker(target_cycle,
                                          m_system.GetSystemTimers().GetTicksPerSecond());
  }};

  if (IsSpeedUnlimited())
  {
    ResetThrottle(target_cycle);
    m_throttle_disable_vi_int = false;
    return;
  }

  // Push throttle reference values forward by exact seconds.
  // This avoids drifting from cumulative rounding errors.
  {
    const s64 sec_adj = (target_cycle - m_throttle_reference_cycle) / m_throttle_adj_clock_per_sec;
    const s64 cycle_adj = sec_adj * m_throttle_adj_clock_per_sec;

    m_throttle_reference_cycle += cycle_adj;
    m_throttle_reference_time += std::chrono::seconds{sec_adj};
  }

  TimePoint target_time = CalculateTargetHostTimeInternal(target_cycle);

  const TimePoint min_target = time - m_max_fallback;

  // "Correct Time Drift" setting prevents timing relaxing.
  if (!m_correct_time_drift && target_time < min_target)
  {
    // Core is running too slow.. i.e. CPU bottleneck.
    const DT adjustment = min_target - target_time;
    DEBUG_LOG_FMT(CORE, "Core can not keep up with timings! [relaxing timings by {} us]",
                  DT_us(adjustment).count());

    m_throttle_reference_time += adjustment;
    target_time += adjustment;
  }

  UpdateVISkip(time, target_time);

#if defined(__EMSCRIPTEN__) && BEM_THROTTLE_SIZING
  {
    // [throttle-sizing TEMP] Split the about-to-be-taken sleep by finish-inflight
    // (0x026B1A30): sleep WHILE a PE_FINISH is pending == wall-clock-bound wait
    // (the Case-B bad regime the narrow fix targets) vs WHILE none pending ==
    // legitimate emulated-time VI pacing to keep. If open >> closed, "decline/cap
    // sleep while finish-inflight != 0" is confirmed and Advance stays untouched.
    const double sleep_ms =
        std::chrono::duration<double, std::milli>(target_time - time).count();
    if (sleep_ms > 0.0)
    {
      const bool fin =
          *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1A30u)) != 0u;
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(fin ? 0x026B3410u : 0x026B3414u)) +=
          static_cast<u32>(sleep_ms * 10.0);  // 0.1ms units
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(fin ? 0x026B3418u : 0x026B341Cu)) += 1u;
      static u32 s_dump = 0u;
      if ((++s_dump & 0xFFu) == 0u)
      {
        EM_ASM(
            {
              console.log('[throttle-sizing] sleepMs finish-open=' + ($0 / 10).toFixed(0) +
                          ' finish-closed=' + ($1 / 10).toFixed(0) + ' | sleeps open=' + $2 +
                          ' closed=' + $3);
            },
            *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3410u)),
            *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3414u)),
            *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3418u)),
            *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B341Cu)));
      }
    }
  }
#endif

  SleepUntil(target_time);
}

void CoreTimingManager::UpdateSpeedLimit(s64 cycle, double new_speed)
{
  m_emulation_speed = new_speed;

  const u32 new_clock_per_sec =
      std::lround(m_system.GetSystemTimers().GetTicksPerSecond() * new_speed);

  const bool was_limited = m_throttle_adj_clock_per_sec != 0;
  if (was_limited)
  {
    // Adjust throttle reference for graceful clock speed transition.
    const s64 ticks = cycle - m_throttle_reference_cycle;
    const s64 new_ticks = ticks * new_clock_per_sec / m_throttle_adj_clock_per_sec;
    m_throttle_reference_cycle = cycle - new_ticks;
  }

  m_throttle_adj_clock_per_sec = new_clock_per_sec;
}

void CoreTimingManager::ResetThrottle(s64 cycle)
{
  m_throttle_reference_cycle = cycle;
  m_throttle_reference_time = Clock::now();
}

void CoreTimingManager::UpdateVISkip(TimePoint current_time, TimePoint target_time)
{
  const DT vi_fallback = std::min(m_max_variance, m_max_fallback);

  // Skip the VI interrupt if the CPU is lagging by a certain amount.
  // It doesn't matter what amount of lag we skip VI at, as long as it's constant.
  const TimePoint vi_target = current_time - vi_fallback / 2;
  m_throttle_disable_vi_int = target_time < vi_target;
}

bool CoreTimingManager::GetVISkip() const
{
  return m_throttle_disable_vi_int && g_ActiveConfig.bVISkip && !Core::WantsDeterminism();
}

float CoreTimingManager::GetOverclock() const
{
  return m_config_oc_factor;
}

bool CoreTimingManager::UseSyncOnSkipIdle() const
{
  return m_config_sync_on_skip_idle;
}

void CoreTimingManager::LogPendingEvents() const
{
  auto clone = m_event_queue;
  std::ranges::sort(clone);
  for (const Event& ev : clone)
  {
    INFO_LOG_FMT(POWERPC, "PENDING: Now: {} Pending: {} Type: {}", m_globals.global_timer, ev.time,
                 *ev.type->name);
  }
}

// Should only be called from the CPU thread after the PPC clock has changed
void CoreTimingManager::AdjustEventQueueTimes(u32 new_ppc_clock, u32 old_ppc_clock)
{
  const s64 ticks = m_globals.global_timer;

  UpdateSpeedLimit(ticks, m_emulation_speed);

  g_perf_metrics.AdjustClockSpeed(ticks, new_ppc_clock, old_ppc_clock);

  for (Event& ev : m_event_queue)
  {
    const s64 ev_ticks = (ev.time - ticks) * new_ppc_clock / old_ppc_clock;
    ev.time = ticks + ev_ticks;
  }
}

void CoreTimingManager::Idle()
{
  if (m_config_sync_on_skip_idle)
  {
    // When the FIFO is processing data we must not advance because in this way
    // the VI will be desynchronized. So, We are waiting until the FIFO finish and
    // while we process only the events required by the FIFO.
    m_system.GetFifo().FlushGpu();
  }

  auto& ppc_state = m_system.GetPPCState();
  PowerPC::UpdatePerformanceMonitor(ppc_state.downcount, 0, 0, ppc_state);
  m_idled_cycles += DowncountToCycles(ppc_state.downcount);
  ppc_state.downcount = 0;
}

std::string CoreTimingManager::GetScheduledEventsSummary() const
{
  std::string text = "Scheduled events\n";
  text.reserve(1000);

  auto clone = m_event_queue;
  std::ranges::sort(clone);
  for (const Event& ev : clone)
  {
    text += fmt::format("{} : {} {:016x}\n", *ev.type->name, ev.time, ev.userdata);
  }
  return text;
}

u32 CoreTimingManager::GetFakeDecStartValue() const
{
  return m_fake_dec_start_value;
}

void CoreTimingManager::SetFakeDecStartValue(u32 val)
{
  m_fake_dec_start_value = val;
}

u64 CoreTimingManager::GetFakeDecStartTicks() const
{
  return m_fake_dec_start_ticks;
}

void CoreTimingManager::SetFakeDecStartTicks(u64 val)
{
  m_fake_dec_start_ticks = val;
}

u64 CoreTimingManager::GetFakeTBStartValue() const
{
  return m_globals.fake_TB_start_value;
}

void CoreTimingManager::SetFakeTBStartValue(u64 val)
{
  m_globals.fake_TB_start_value = val;
}

u64 CoreTimingManager::GetFakeTBStartTicks() const
{
  return m_globals.fake_TB_start_ticks;
}

void CoreTimingManager::SetFakeTBStartTicks(u64 val)
{
  m_globals.fake_TB_start_ticks = val;
}

void GlobalAdvance()
{
  Core::System::GetInstance().GetCoreTiming().Advance();
}

void GlobalIdle()
{
  Core::System::GetInstance().GetCoreTiming().Idle();
}

}  // namespace CoreTiming
