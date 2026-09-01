// aot_stubs_next — link-time definitions for the powerpc-next emitter's runtime
// dispatch/promotion globals (normally defined in bementalJIT/src/block_cache.cpp,
// which pulls in the whole emscripten runtime and can't link into a native tool).
// The AoT driver never EXECUTES emitted code, so these only need to exist with the
// right type/linkage; the emitter reads g_bem_chain_enabled / g_bem_promote_enabled
// at emit time (both left at their shipping values below).
#include <cstdint>

#define BEM_DISP_BUCKETS (1u << 18)   // must match block_cache.cpp BEM_DISP_BITS=18

// Global-scope, C linkage — matches block_cache.cpp (symbols _g_bem_*).
uint32_t      g_bem_disp_tag[BEM_DISP_BUCKETS];
int32_t       g_bem_disp_slot[BEM_DISP_BUCKETS];
uint32_t      g_bem_rtag[BEM_DISP_BUCKETS];
int32_t       g_bem_rslot[BEM_DISP_BUCKETS];
uint32_t      g_bem_mrtag[BEM_DISP_BUCKETS];
int32_t       g_bem_mrslot[BEM_DISP_BUCKETS];
uint32_t      g_bem_pc_exec[BEM_DISP_BUCKETS];
uint32_t      g_bem_promote_ring[256];
uint32_t      g_bem_promote_n = 0u;
unsigned char g_bem_chain_enabled = 1;   // in-wasm chain toggle (emit-time read)
unsigned char g_bem_promote_enabled = 0; // shipping = OFF
int           g_bem_gp_dirty = 0;
