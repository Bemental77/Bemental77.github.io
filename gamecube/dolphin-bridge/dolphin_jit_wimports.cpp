// dolphin_jit_wimports.cpp — bementalJIT WIMPORT callback bridge.
//
// JIT-compiled blocks (per gamecube/bementalJIT/guests/powerpc-next/
// ppc_emit.cpp:316-328) import 11 host functions from the wasm "env":
//   ppc_read8/16/32, ppc_write8/16/32, ppc_interp, ppc_check_exc,
//   ppc_break_block, ppc_hle_check, ppc_hle_fire.
//
// The JS-side import bootstrap in gamecube/bementalJIT/src/block_cache.cpp
// resolves Module._dolphin_<name> to env.<name> at instantiate-time
// (pthread-side upgrade path inside compile_raw). These _dolphin_<name>
// symbols MUST be exported via EMSCRIPTEN_KEEPALIVE AND the link script's
// EXPORTED_FUNCTIONS so they're callable as Module._dolphin_<name>.
//
// Without these definitions + exports: every block compile in
// BlockCache::compile fails with
//   LinkError: env.ppc_read8 function import requires a callable
// and JitWasm::Run falls back to CachedInterpreter every dispatch. The
// 2026-05-30 post-Run-rewrite probe confirmed this empirically — 10+
// compile attempts at PC=0x800ebea0 all returned -1, zero ok prints.
//
// All callbacks route to Dolphin's canonical CPU-thread API per
// gamecube/dolphin-src/Source/Core/Core/PowerPC/MMU.h:230-234,
// PowerPC.h:339-340, HLE/HLE.h:65-69. Authored fresh per
// feedback_no_bak_shims_2026_05_30 — no .bak ports.

#ifdef __EMSCRIPTEN__

#include <emscripten.h>
#include <cstdint>

#include "Common/CommonTypes.h"
#include "Core/HLE/HLE.h"
#include "Core/PowerPC/Interpreter/Interpreter.h"
#include "Core/PowerPC/MMU.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"

extern "C" {

EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_read8(uint32_t addr) {
    return Core::System::GetInstance().GetMMU().Read<u8>(addr);
}

EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_read16(uint32_t addr) {
    return Core::System::GetInstance().GetMMU().Read<u16>(addr);
}

EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_read32(uint32_t addr) {
    return Core::System::GetInstance().GetMMU().Read<u32>(addr);
}

EMSCRIPTEN_KEEPALIVE
void dolphin_write8(uint32_t addr, uint32_t val) {
    Core::System::GetInstance().GetMMU().Write<u8>(static_cast<u8>(val), addr);
}

EMSCRIPTEN_KEEPALIVE
void dolphin_write16(uint32_t addr, uint32_t val) {
    Core::System::GetInstance().GetMMU().Write<u16>(static_cast<u16>(val), addr);
}

EMSCRIPTEN_KEEPALIVE
void dolphin_write32(uint32_t addr, uint32_t val) {
    Core::System::GetInstance().GetMMU().Write<u32>(val, addr);
}

// Pending-exception drain after a block exit. Mirrors what every native
// Dolphin JIT epilogue invokes. The cookie arg is unused (kept for the
// JIT's generic type-1 import signature: (i32) -> i32).
EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_check_exc(uint32_t /*unused*/) {
    PowerPC::CheckExceptionsFromJIT(Core::System::GetInstance().GetPowerPC());
    return 0;
}

// Block-exit marker. Reserved for future trap reporting / hot-path stats.
// The emitter declares it as a type-2 import (i32, i32) -> ().
EMSCRIPTEN_KEEPALIVE
void dolphin_break_block(uint32_t /*unused_a*/, uint32_t /*unused_b*/) {
    // intentional no-op
}

// HLE table lookup. Returns hook_index > 0 iff the PC is hooked, else 0.
// Type-1 signature: (i32 pc) -> i32 hook_index.
EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_hle_check(uint32_t pc) {
    return HLE::GetHookByAddress(pc);
}

// HLE handler invocation. Routes through HLE::ExecuteFromJIT which sets
// up the CPUThreadGuard internally. Type-3 signature: (i32 pc, i32
// hook_index) -> i32 (return value reserved; HLE handlers themselves
// don't return data via this path).
EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_hle_fire(uint32_t pc, uint32_t hook_index) {
    HLE::ExecuteFromJIT(pc, hook_index, Core::System::GetInstance());
    return 0;
}

// One-instruction interpreter fallback. Type-2 signature: (i32 unused,
// i32 pc) -> (). The wasm emitter sets ppc_state.pc to the op's address
// before calling here (per ppc_emit.cpp:405-407); the guard below
// catches the case where an earlier op in the same block branched and
// already updated pc — re-stepping the original op would corrupt state.
EMSCRIPTEN_KEEPALIVE
void dolphin_interp(uint32_t /*unused*/, uint32_t pc) {
    auto& system = Core::System::GetInstance();
    auto& ppc_state = system.GetPPCState();
    if (ppc_state.pc != pc) return;
    system.GetInterpreter().SingleStep();
}

// dolphin_evict_block lives in JitWasm.cpp (which has the bementalJIT
// include path for m_wasm_cache).

}  // extern "C"

#endif  // __EMSCRIPTEN__
