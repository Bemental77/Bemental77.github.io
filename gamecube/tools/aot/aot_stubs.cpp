// aot_stubs — link-time definitions for globals gekko_emit.cpp expects from
// block_cache.cpp (which pulls in the whole runtime and emscripten). The AoT
// driver never executes emitted code, so these only need to exist.
#include <cstdint>

namespace bemental {
uint32_t g_blr_ras[512];
uint32_t g_blr_ras_sp = 0;
uint32_t g_blr_chain = 0;
}  // namespace bemental

#include "bementalJIT/perf_runtime.h"
namespace bemental::perf_runtime {
void inc(bemental::PerfSlot, u64) {}
}  // namespace bemental::perf_runtime
