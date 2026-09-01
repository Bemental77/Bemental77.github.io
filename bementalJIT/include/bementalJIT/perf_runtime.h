#pragma once
//
// Runtime performance counter table — one std::atomic<u64> per PerfSlot.
// Lets emit-side and dispatch-side code increment counters concurrently from
// any thread; readers (test harnesses, the SAB mirror layer that copies into
// the perf block at PERF_BLOCK_SAB_OFFSET) read snapshots.
//
// Usage:
//   bemental::perf_runtime::inc(PERF_SLOT_BLOCK_EMIT);
//   u64 v = bemental::perf_runtime::read(PERF_SLOT_BLOCK_EMIT);
//   auto snap = bemental::perf_runtime::snapshot();
//
// Counters are global state. Tests that want isolation must call
// reset_all() between runs.

#include "bementalJIT/types.h"
#include "bementalJIT/perf_counters.h"

#include <array>
#include <atomic>

namespace bemental::perf_runtime {

using CounterArray = std::array<u64, PERF_SLOT_COUNT>;

void inc(PerfSlot slot, u64 delta = 1);
u64  read(PerfSlot slot);
CounterArray snapshot();
void reset_all();

}  // namespace bemental::perf_runtime
