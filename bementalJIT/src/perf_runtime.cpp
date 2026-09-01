// Runtime performance counter table — implementation.
// See bementalJIT/perf_runtime.h for contract.

#include "bementalJIT/perf_runtime.h"

namespace bemental::perf_runtime {

// One atomic per slot. Zero-initialized per the language guarantees.
static std::array<std::atomic<u64>, PERF_SLOT_COUNT> g_counters{};

void inc(PerfSlot slot, u64 delta) {
    g_counters[slot].fetch_add(delta, std::memory_order_relaxed);
}

u64 read(PerfSlot slot) {
    return g_counters[slot].load(std::memory_order_relaxed);
}

CounterArray snapshot() {
    CounterArray out{};
    for (u32 i = 0; i < PERF_SLOT_COUNT; ++i) {
        out[i] = g_counters[i].load(std::memory_order_relaxed);
    }
    return out;
}

void reset_all() {
    for (u32 i = 0; i < PERF_SLOT_COUNT; ++i) {
        g_counters[i].store(0, std::memory_order_relaxed);
    }
}

}  // namespace bemental::perf_runtime
