// dolphin_jit_wimports.cpp — bementalJIT WIMPORT callback bridge.
//
// JIT-compiled blocks (per gamecube/bementalJIT/guests/powerpc-next/
// ppc_emit.cpp:354-368) import 13 host functions from the wasm "env":
//   ppc_read8/16/32, ppc_write8/16/32, ppc_interp, ppc_check_exc,
//   ppc_break_block, ppc_hle_check, ppc_hle_fire, ppc_msr_updated,
//   ppc_gather_drain.
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
#include "Common/Logging/Log.h"
#include "Core/HLE/HLE.h"
#include "Core/HW/GPFifo.h"
#include "Core/HW/Memmap.h"
#include "Core/HW/ProcessorInterface.h"
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
    // [ax-vi-w] Trace VI MMIO 16-bit writes (0xCC002000..0xCC0020FF). VI
    // registers are 16-bit per Source/Core/Core/HW/VideoInterface.cpp.
    // Diagnostic for "VI vblank IRQ never fires" — check whether MP4 ever
    // programs the VI Interrupt Registers (0xCC002030..0xCC002037).
    {
        const uint32_t phys = addr & 0x0FFFFFFF;
        if (phys >= 0x0C002000 && phys <= 0x0C0020FF) {
            static uint32_t s_viw_n = 0;
            if (s_viw_n < 80) {
                ++s_viw_n;
                NOTICE_LOG_FMT(VIDEOINTERFACE,
                               "[ax-vi-w] VI MMIO write16 n={} addr={:#x} val={:#x}",
                               s_viw_n, addr, val & 0xFFFF);
            }
        }
    }
    Core::System::GetInstance().GetMMU().Write<u16>(static_cast<u16>(val), addr);
}

EMSCRIPTEN_KEEPALIVE
void dolphin_write32(uint32_t addr, uint32_t val) {
    Core::System::GetInstance().GetMMU().Write<u32>(val, addr);
}

// Pending-exception drain after a block exit. Mirrors what every native
// Dolphin JIT epilogue invokes. The cookie arg is unused (kept for the
// JIT's generic type-1 import signature: (i32) -> i32).
//
// Gates external-interrupt (EI) delivery on MEM[0xC0] (OSCurrentContext
// pointer) being non-zero. The GameCube OS sets MEM[0xC0] to
// &__OSDefaultContext during OSInit BEFORE enabling any interrupts.
// However, the apploader / bootrom may issue mtmsr EE=1 before the OS
// has reached that point. The EI vector at 0x500 saves register state
// via `lwz r4, 0xC0(r0); ...; stw rN, OSContext.N(r4)`. If r4=0, the
// save lands at MEM[0..0x1ac] — corrupting low memory and the
// caller-frame's stack-saved callee-save regs (r28..r31). Observed
// 2026-06-05 as: EI fires at OSEnableInterrupts+0xc → vector handler
// chain runs through trampoline at 0x800eb71c → blrl reads r31=0
// (corrupted by EI vector's save into low memory) → PC=0 → walks
// garbage → Program-TRAP at PHYS 0x20 → __DBExceptionDestinationAux
// → PPCHalt at 0x800e34d0.
//
// Pass-7 (2026-06-06): attempted full removal regressed boot (didn't
// reach DSP halt 0954→0950). Gate is load-bearing for our path even if
// not present in upstream. Restored.
EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_check_exc(uint32_t /*unused*/) {
    auto& sys = Core::System::GetInstance();
    auto& ps = sys.GetPPCState();
    auto& ppc = sys.GetPowerPC();

    // [ax-queue] Snapshot RunQueueBits (0x1D4350) + retraceQueue (0x1D4430) +
    // retraceCount (0x1D4428 — the value VIWaitForRetrace's do-while watches).
    // Per ~/gc_refs/dolsdk2001/src/vi/vi.c:432-443, main thread re-sleeps if
    // retraceCount doesn't advance between OSSleepThread wakes. Log on CHANGE.
    {
        static u32 s_prev_run_bits = 0xFFFFFFFFu;
        static u32 s_prev_q_head = 0xFFFFFFFFu;
        static u32 s_prev_q_tail = 0xFFFFFFFFu;
        static u32 s_prev_rcount = 0xFFFFFFFFu;
        static u32 s_run_log_count = 0;
        static u32 s_q_log_count = 0;
        static u32 s_rc_log_count = 0;
        const u8* ram = sys.GetMemory().GetRAM();
        if (ram) {
            u32 run_bits = (u32(ram[0x1D4350]) << 24) | (u32(ram[0x1D4351]) << 16) |
                           (u32(ram[0x1D4352]) << 8) | u32(ram[0x1D4353]);
            u32 q_head  = (u32(ram[0x1D4430]) << 24) | (u32(ram[0x1D4431]) << 16) |
                          (u32(ram[0x1D4432]) << 8) | u32(ram[0x1D4433]);
            u32 q_tail  = (u32(ram[0x1D4434]) << 24) | (u32(ram[0x1D4435]) << 16) |
                          (u32(ram[0x1D4436]) << 8) | u32(ram[0x1D4437]);
            u32 rcount  = (u32(ram[0x1D4428]) << 24) | (u32(ram[0x1D4429]) << 16) |
                          (u32(ram[0x1D442A]) << 8) | u32(ram[0x1D442B]);
            if (run_bits != s_prev_run_bits && s_run_log_count < 200) {
                s_run_log_count++;
                NOTICE_LOG_FMT(POWERPC,
                               "[ax-queue] RunQueueBits {:#x} -> {:#x} (n={})",
                               s_prev_run_bits, run_bits, s_run_log_count);
                s_prev_run_bits = run_bits;
            }
            if ((q_head != s_prev_q_head || q_tail != s_prev_q_tail) && s_q_log_count < 200) {
                s_q_log_count++;
                NOTICE_LOG_FMT(POWERPC,
                               "[ax-queue] retraceQueue head:{:#x}->{:#x} tail:{:#x}->{:#x} (n={})",
                               s_prev_q_head, q_head, s_prev_q_tail, q_tail, s_q_log_count);
                s_prev_q_head = q_head;
                s_prev_q_tail = q_tail;
            }
            if (rcount != s_prev_rcount && s_rc_log_count < 400) {
                s_rc_log_count++;
                NOTICE_LOG_FMT(POWERPC,
                               "[ax-rcount] retraceCount {} -> {} (n={})",
                               s_prev_rcount, rcount, s_rc_log_count);
                s_prev_rcount = rcount;
            }
        }
    }

    if (ps.Exceptions & EXCEPTION_EXTERNAL_INT) {
        // Read MEM[0xC0] directly from host RAM (avoids MMU translation
        // path's MSR.DR-state dependency). Memory::MemoryManager::GetRAM()
        // returns the MEM1 base; OSCurrentContext lives at physical 0xC0.
        const u8* ram = sys.GetMemory().GetRAM();
        u32 os_current_context_ptr = 0;
        if (ram) {
            // Big-endian 4-byte read from MEM[0xC0..0xC3].
            os_current_context_ptr = (u32(ram[0xC0]) << 24) |
                                     (u32(ram[0xC1]) << 16) |
                                     (u32(ram[0xC2]) <<  8) |
                                      u32(ram[0xC3]);
        }
        if (os_current_context_ptr == 0) {
            // OSCurrentContext not yet installed. Suppress EI delivery for
            // THIS call by temporarily clearing the EXT_INT pending bit
            // (other exceptions, if pending, still process), then restore
            // it so subsequent dolphin_check_exc calls re-evaluate.
            const u32 saved = ps.Exceptions & EXCEPTION_EXTERNAL_INT;
            ps.Exceptions &= ~EXCEPTION_EXTERNAL_INT;
            PowerPC::CheckExceptionsFromJIT(ppc);
            ps.Exceptions |= saved;
            return 0;
        }

        // Jit64 mtmsr "issue 4336": when the EI is caused by the Command
        // Processor (GPU FIFO), defer delivery so the next block runs and
        // feeds the FIFO rather than dispatching the EI vector. Matches
        // Jit_SystemRegisters.cpp:462-465.
        const u32 int_cause = sys.GetProcessorInterface().GetCause();
        if (int_cause & ProcessorInterface::INT_CAUSE_CP) {
            return 0;
        }
    }

    PowerPC::CheckExceptionsFromJIT(ppc);
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
    // Pass-3 audit reverted the FIX 4 entry-only + IsEnabled gates: the
    // bridge installs HLE patches via HLE::Patch(addr, name) at
    // EmscriptenWorker.cpp:332-334 without populating PPCSymbolDB, so
    // GetHookByFunctionAddress returns 0 for everything. The HookFlag::Debug
    // gate also silences the manually-installed OSReport/DBPrintf hooks
    // since IsEnabled is off in JIT mode. Keeping GetHookByAddress until
    // either (a) the install path is rewritten to use PatchFunctions after
    // populating the symbol DB from tools/gsne8p.map, or (b) the bridge
    // marks these patches HookFlag::Fixed at install time.
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
    // Pass-2 audit (w6oeq0l6e RANK 5): SingleStep() calls CoreTiming.Advance,
    // sets slice_length=1, forces downcount=0, and calls CheckExceptions —
    // all of which mutate state mid-block. SingleStepInner is the per-op-only
    // path that just executes one instruction. Mirrors Interpreter.cpp:263,278
    // FastRun pattern.
    auto& system = Core::System::GetInstance();
    auto& ppc_state = system.GetPPCState();
    if (ppc_state.pc != pc) return;
    system.GetInterpreter().SingleStepInner();
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

// Drain GPU gather-pipe at block exit. Mirrors Jit64 Cleanup()
// (Jit.cpp:454-490) gather-pipe overflow check + GPFifo::UpdateGatherPipe.
// Type-2 import signature (i32, i32) -> () — both args unused.
//
// Pass-2 audit (w6oeq0l6e RANK 9): without this, post-boot GPU FIFO writes
// (stw to 0xCC008000) accumulate past GATHER_PIPE_SIZE without ever
// flushing → CP_INT / PE_TOKEN / PE_FINISH never fire → games wait
// forever on GP-triggered fences.
EMSCRIPTEN_KEEPALIVE
void dolphin_gather_drain(uint32_t /*unused_a*/, uint32_t /*unused_b*/) {
    static u64 s_drain_n = 0;
    if ((++s_drain_n & 0xFFu) == 1) {
        NOTICE_LOG_FMT(POWERPC, "[ax-pe] dolphin_gather_drain n={}", s_drain_n);
    }
    auto& system = Core::System::GetInstance();
    GPFifo::UpdateGatherPipe(system.GetGPFifo());
}

// dolphin_evict_block lives in JitWasm.cpp (which has the bementalJIT
// include path for m_wasm_cache).

// MEM1 address/size accessors. The worker_funcs.js `get-ram-info` cmd
// calls Module._dolphin_get_ram_addr() / _dolphin_get_ram_size() and
// replies to the page with the values. The page polls this until non-
// zero, then forwards to the ppc-worker so its self-compile path can
// read instructions directly from SAB-mapped guest RAM. Tools that need
// to walk guest data (OS thread state, etc.) use the same path.
//
// The old dolphin-src.bak/JitWasm.cpp also wrote (ram_addr, ram_size,
// sentinel=0xCAFEBABE) to SAB[0x02500020/24/28] from inside JitWasm::Run,
// which let the page poll the SAB sentinel directly without sending a
// message. The re-extracted dolphin-src (2026-05-29) doesn't carry that
// publication; the ram-info request/reply mailbox is the only path.
EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_get_ram_addr() {
    auto& memory = Core::System::GetInstance().GetMemory();
    // GetRAM() returns u8*& — cast to wasm-side u32 (a pointer in the
    // shared linear memory). Returns 0 before Memory::Init() runs.
    u8* ram = memory.GetRAM();
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ram));
}

EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_get_ram_size() {
    auto& memory = Core::System::GetInstance().GetMemory();
    return static_cast<uint32_t>(memory.GetRamSize());
}

}  // extern "C"

#endif  // __EMSCRIPTEN__
