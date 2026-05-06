#pragma once
//
// Runtime performance counter table — implementation in src/perf_runtime.cpp.
// Mirror of bementalJIT/include/bementalJIT/perf_runtime.h. Keep in sync.
//
// Wired at every emit/dispatch site that wants attribution. JitWasm-side
// callers add their own counters into the same table; the SAB-mirror layer
// (Dolphin worker) periodically copies snapshot() into the SAB perf block
// at PERF_BLOCK_SAB_OFFSET so the JS probe driver can read by slot.

#include "bementalCompiler/types.h"
#include "bementalCompiler/perf_counters.h"

#include <array>
#include <atomic>

namespace bemental::perf_runtime {

using CounterArray = std::array<u64, PERF_SLOT_COUNT>;

void inc(PerfSlot slot, u64 delta = 1);
u64  read(PerfSlot slot);
CounterArray snapshot();
void reset_all();

}  // namespace bemental::perf_runtime
