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
#include "Core/HW/Memmap.h"
#include "Core/PowerPC/Gekko.h"
#include "Core/PowerPC/Interpreter/Interpreter.h"
#include "Core/PowerPC/MMU.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"

extern "C" {

// EA translation seam: the JIT slow path (jit_load_store.cpp::emit_slowmem_*
// + const-MMIO routing at :348-465) hands MMU the RAW guest virtual EA
// (e.g. 0xCC003004 for PI MASK, 0x817ede28 for MEM1 Arena+8). MMU::Write/Read
// route through WriteToHardware/ReadFromHardware which call MMU::TranslateAddress
// when MSR.DR=1 — TranslateAddress consults the DBAT cache which BS2Emu
// installs at Boot_BS2Emu.cpp:121-137 (DBAT0 80000000→00000000 cached MEM1,
// DBAT1 C0000000→00000000 uncached/MMIO mirror). Empirical probe 2026-06-04:
// at PC=0x800e4bd0 (DSP_CONTROL write inside __OSInitAudioSystem), MSR.DR=1,
// SPR_DBAT0/1 hold the correct SetupBAT values, and m_dbat_table[0x6600] =
// 0x0C000005 (PA=0x0C000000 | BAT_MAPPED_BIT | BAT_WI_BIT). Passing the raw
// 0xCC00500A therefore translates to 0x0C00500A and reaches GetMMIOMapping
// → DSP::Write<u16>. The prior unconditional `addr & 0x3FFFFFFF` mask was a
// bug: it stripped the high bits, then MMU saw a physical address with no
// BAT mapping → DSI exception → 26K "Invalid write to 0x0c00xxxx" warnings
// that fully wedged __OSInitAudioSystem on the DSP_CR bit-0x20 poll.

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

// HLE prologue check. Per bementalJIT's emit_hle_prologue contract
// (hle_prologue.cpp:18-28): the check FIRES the hook (if any) and
// returns non-zero only when execution was "replaced" — meaning
// ppc_state.pc was rewritten to a new value (typically LR) and the
// block should exit with the new pc. Returns 0 when:
//   - No hook at this PC (normal block dispatch continues), OR
//   - HookType::Start (hook ran a side-effect like OSReport logging
//     but didn't redirect control — block body must still execute).
//
// Returning the bare hook_index without firing was the original bug:
// the prologue saw non-zero, early-exited reading ppc_state.pc which
// still equaled the HLE-hooked PC, and the dispatcher re-entered the
// same block → infinite HLE-check loop. Symptom: DBPrintf @
// 0x800ecfa4 dispatched 36M+ times in 60s, never executing its body
// or advancing.
EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_hle_check(uint32_t pc) {
    const uint32_t hook_index = HLE::GetHookByAddress(pc);
    if (hook_index == 0) return 0;

    auto& system = Core::System::GetInstance();
    auto& ppc_state = system.GetPPCState();
    const HLE::HookType type = HLE::GetHookTypeByIndex(hook_index);

    HLE::ExecuteFromJIT(pc, hook_index, system);

    // The interpreter convention is `pc = npc` after each instruction;
    // Replace-style hooks set npc = LR. Sync pc here so the prologue
    // reads the post-hook pc and returns it.
    ppc_state.pc = ppc_state.npc;

    // HookType::Start = hook ran a side effect, body still needs to
    // run → return 0 so the prologue does NOT early-exit.
    // HookType::Replace = hook redirected control (npc=LR) → return
    // non-zero so the prologue exits this block with the new pc.
    return (type == HLE::HookType::Replace) ? 1u : 0u;
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

// Recompute feature_flags / membase from the current MSR. Called from
// emit_mtmsr immediately after the new MSR is stored to ppc_state. Without
// this, after mtmsr flips MSR.IR/DR the host-side translation context
// (feature_flags, membase) stays stale → MMIO/RAM router rejects subsequent
// addresses as "Unable to resolve" → exception vector dispatch reads wrong
// → DBExceptionDestination → PPCHalt wedge. Mirrors Jit64::EmitUpdateMembase
// (Jit.cpp:714) which is called from every MSR-changing op. Type-2 import
// signature (i32, i32) -> () — both args unused; the handler reads the
// global m_ppc_state via Core::System.
EMSCRIPTEN_KEEPALIVE
void dolphin_msr_updated(uint32_t /*unused_a*/, uint32_t /*unused_b*/) {
    Core::System::GetInstance().GetPowerPC().MSRUpdated();
}

// dolphin_evict_block lives in JitWasm.cpp (which has the bementalJIT
// include path for m_wasm_cache).

}  // extern "C"

#endif  // __EMSCRIPTEN__
