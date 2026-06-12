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
#include <string>
#include <utility>

#include "Common/CommonTypes.h"
#include "Common/Logging/Log.h"
#include "Core/HLE/HLE.h"
#include "Core/HW/GPFifo.h"
#include "Core/HW/Memmap.h"
#include "Core/HW/ProcessorInterface.h"
#include "Core/PowerPC/Gekko.h"
#include "Core/PowerPC/Interpreter/Interpreter.h"
#include "Core/PowerPC/MMU.h"
#include "VideoCommon/CommandProcessor.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"

// Cross-TU arm channel for the [ax-wake-traj] dispatch trace (consumed in
// bementalJIT block_cache.cpp dispatch_raw).
namespace bemental {
extern int g_ax_wake_arm;
extern int g_ax_wake_ring[256];
extern int g_ax_wake_ring_n;
// [pc-census 2026-06-12] temporary (strip per gate #8): hot-PC/handle ring
// filled by block_cache dispatch sites; drained + NOTICE_LOG'd from
// dolphin_gather_drain below (dispatch-context output never reaches the
// probe). Values >= 0x80000000 are guest PCs (chain/region paths); small
// ints are block handles (dispatch_raw path).
extern int g_pc_census_ring[256];
extern int g_pc_census_n;
extern u64 g_pc_census_total;
}
static void ax_wake_arm_set() { bemental::g_ax_wake_arm = 192; }


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
            // [ax-gates] boot-gate timeline (2026-06-10): GlobalCounter
            // 0x1D3A54 (main-loop completions), omcurovl/omnextovl
            // 0x1D3CE0/E4, fadeStat 0x1D3D18, HuDvdErrWait 0x1D3A04,
            // GXWaitDrawDone flag region — log on ANY change, sampled.
            {
                static u32 s_prev_gc = 0xFFFFFFFFu, s_prev_ovl = 0xFFFFFFFFu,
                           s_prev_misc = 0xFFFFFFFFu;
                static u32 s_gate_log_n = 0;
                u32 gc   = (u32(ram[0x1D3A54]) << 24) | (u32(ram[0x1D3A55]) << 16) |
                           (u32(ram[0x1D3A56]) << 8) | u32(ram[0x1D3A57]);
                u32 ovl  = (u32(ram[0x1D3CE0]) << 24) | (u32(ram[0x1D3CE3]) << 16) |
                           (u32(ram[0x1D3CE4]) << 8) | u32(ram[0x1D3CE7]);
                u32 misc = (u32(ram[0x1D3D18]) << 24) | (u32(ram[0x1D3A07]) << 16) |
                           u32(ram[0x1D3A04]);
                // Wild-store watch: minimumVcount/minimumVcountf
                // (0x1D3B04/0x1D3B00, zero-initialized .sbss) read -1 /
                // 0x59800000 every run with HuSysVWaitSet NEVER dispatched.
                {
                    static u32 s_prev_mv = 0xEEEEEEEEu;
                    u32 mv = (u32(ram[0x1D3B04]) << 24) | (u32(ram[0x1D3B05]) << 16) |
                             (u32(ram[0x1D3B06]) << 8) | u32(ram[0x1D3B07]);
                    if (mv != s_prev_mv) {
                        NOTICE_LOG_FMT(POWERPC,
                                       "[ax-minvc] minimumVcount {:#x} -> {:#x} (detect pc={:#x} lr={:#x})",
                                       s_prev_mv, mv, ps.pc, LR(ps));
                        s_prev_mv = mv;
                    }
                }
                // PAD driver state (authoritative host-side read; the SAB
                // dump tool showed all-zero here, contradicting its own
                // ResettingChan=32 initializer — suspected stale-MEM1-copy
                // scan hit).
                static u32 s_prev_pad = 0xFFFFFFFFu;
                u32 pad_bits = (u32(ram[0x1D44EF]) << 24) | (u32(ram[0x1D44F3]) << 16) |
                               (u32(ram[0x1D44FB]) << 8) | u32(ram[0x1D391B]);
                if (pad_bits != s_prev_pad) {
                    NOTICE_LOG_FMT(POWERPC,
                                   "[ax-pad] EnabledBits={:#x} ResettingBits={:#x} WaitingBits={:#x} CheckingBits={:#x} PendingBits={:#x} ResettingChan={}",
                                   (u32(ram[0x1D44EC]) << 24) | (u32(ram[0x1D44ED]) << 16) | (u32(ram[0x1D44EE]) << 8) | u32(ram[0x1D44EF]),
                                   (u32(ram[0x1D44F0]) << 24) | (u32(ram[0x1D44F1]) << 16) | (u32(ram[0x1D44F2]) << 8) | u32(ram[0x1D44F3]),
                                   (u32(ram[0x1D44F8]) << 24) | (u32(ram[0x1D44F9]) << 16) | (u32(ram[0x1D44FA]) << 8) | u32(ram[0x1D44FB]),
                                   (u32(ram[0x1D44FC]) << 24) | (u32(ram[0x1D44FD]) << 16) | (u32(ram[0x1D44FE]) << 8) | u32(ram[0x1D44FF]),
                                   (u32(ram[0x1D4500]) << 24) | (u32(ram[0x1D4501]) << 16) | (u32(ram[0x1D4502]) << 8) | u32(ram[0x1D4503]),
                                   (u32(ram[0x1D3918]) << 24) | (u32(ram[0x1D3919]) << 16) | (u32(ram[0x1D391A]) << 8) | u32(ram[0x1D391B]));
                    s_prev_pad = pad_bits;
                }
                // DrawDone byte 0x1D45F0 + FinishQueue head 0x1D45F4 (GX
                // draw-done handshake; __GXFinishHandler must pulse DrawDone
                // 0->1 for GXWaitDrawDone to exit).
                u32 gxdd = (u32(ram[0x1D45F0]) << 8) | u32(ram[0x1D45F5]);
                static u32 s_prev_gxdd = 0xFFFFFFFFu;
                if (gxdd != s_prev_gxdd) {
                    NOTICE_LOG_FMT(POWERPC, "[ax-gxdd] DrawDone={:#x} FinishQ.head=..{:02x}{:02x}",
                                   u32(ram[0x1D45F0]), u32(ram[0x1D45F6]), u32(ram[0x1D45F7]));
                    s_prev_gxdd = gxdd;
                }
                // [ax-park] DefaultThread (0x1A5828) saved context: srr0
                // (ctx+0x198), lr (ctx+0x84), state (thread+0x2C8 u16),
                // queue ptr (thread+0x2DC) — host-side authoritative read of
                // WHERE main parks. Log on change of srr0/queue.
                {
                    auto rd32 = [&](u32 off) {
                        return (u32(ram[off]) << 24) | (u32(ram[off + 1]) << 16) |
                               (u32(ram[off + 2]) << 8) | u32(ram[off + 3]);
                    };
                    const u32 thr = 0x1A5828;
                    u32 srr0 = rd32(thr + 0x198);
                    u32 lr = rd32(thr + 0x84);
                    u32 queue = rd32(thr + 0x2DC);
                    u32 state = (u32(ram[thr + 0x2C8]) << 8) | u32(ram[thr + 0x2C9]);
                    static u32 s_prev_srr0 = 0xFFFFFFFFu, s_prev_queue = 0xFFFFFFFFu;
                    static u32 s_park_n = 0;
                    if (srr0 != s_prev_srr0 || queue != s_prev_queue) {
                        s_park_n++;
                        // Arm a 48-block dispatch trace on selected wakes
                        // (READY transitions) — consumed by block_cache.cpp's
                        // pre-dispatch EM_ASM via Module.ax_wake_arm.
                        // Drain the wake-trace ring (filled by dispatch_raw).
                        if (bemental::g_ax_wake_arm == 0 && bemental::g_ax_wake_ring_n > 0) {
                            for (int ri = 0; ri < bemental::g_ax_wake_ring_n; ++ri) {
                                NOTICE_LOG_FMT(POWERPC, "[ax-wake-traj] i={} handle={}", ri,
                                               bemental::g_ax_wake_ring[ri]);
                            }
                            bemental::g_ax_wake_ring_n = 0;
                        }
                        static u32 s_wake_n = 0;
                        if (state == 1) s_wake_n++;
                        if (state == 1 && (s_wake_n & 0xFF) == 2) {
                            // Same-thread EM_ASM: check_exc runs on the CPU
                            // pthread — the same JS realm as dispatch_raw's
                            // EM_ASM (MAIN_THREAD_EM_ASM lands in the wrong
                            // realm under PROXY_TO_PTHREAD).
                            ax_wake_arm_set();
                            NOTICE_LOG_FMT(POWERPC, "[ax-arm] armed, readback={}",
                                           bemental::g_ax_wake_arm);
                        }
                        if (s_park_n <= 16 || (s_park_n & 0x3F) == 0) {
                            // r31 = VIWaitForRetrace's startCount (callee-
                            // saved); live rcount = ram retraceCount. If the
                            // saved r31 TRACKS rcount across cycles, the JIT
                            // corrupts r31 (audit r28-r31 class) and the
                            // do-while equality never breaks.
                            u32 r30 = rd32(thr + 0x78);
                            u32 r31 = rd32(thr + 0x7C);
                            u32 live_rcount = rd32(0x1D4428);
                            const u32 pi_cause =
                                sys.GetProcessorInterface().m_interrupt_cause;
                            const u32 pi_mask =
                                sys.GetProcessorInterface().m_interrupt_mask;
                            NOTICE_LOG_FMT(POWERPC,
                                           "[ax-park] srr0={:#x} state={:#x} queue={:#x} r30={} rcount={} cause={:#x} mask={:#x} (n={})",
                                           srr0, state, queue, r30, live_rcount, pi_cause,
                                           pi_mask, s_park_n);
                        }
                        s_prev_srr0 = srr0;
                        s_prev_queue = queue;
                    }
                }
                if (gc != s_prev_gc || ovl != s_prev_ovl || misc != s_prev_misc) {
                    s_gate_log_n++;
                    if (s_gate_log_n <= 16 || (s_gate_log_n & 0x3F) == 0) {
                        NOTICE_LOG_FMT(POWERPC,
                                       "[ax-gates] GlobalCounter={} curovl={:#x}{:02x} nextovl={:#x}{:02x} fade={:#x} dvderr={:#x} (n={})",
                                       gc, u32(ram[0x1D3CE0]), u32(ram[0x1D3CE3]),
                                       u32(ram[0x1D3CE4]), u32(ram[0x1D3CE7]),
                                       u32(ram[0x1D3D18]), u32(ram[0x1D3A04]),
                                       s_gate_log_n);
                    }
                    s_prev_gc = gc; s_prev_ovl = ovl; s_prev_misc = misc;
                }
            }
            if (rcount != s_prev_rcount) {
                s_rc_log_count++;
                // Uncapped (was <400 — the cap produced a phantom "frozen at
                // 399" wedge, 2026-06-10); sample every 64th change + first 8.
                if (s_rc_log_count <= 8 || (s_rc_log_count & 0x3F) == 0) {
                    NOTICE_LOG_FMT(POWERPC,
                                   "[ax-rcount] retraceCount {} -> {} (n={})",
                                   s_prev_rcount, rcount, s_rc_log_count);
                }
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
extern "C" EMSCRIPTEN_KEEPALIVE void dolphin_log_recheck(int phase) {
    // Compare inputs of the VIWaitForRetrace wake re-check block at the
    // moment of its dispatch: r30 = startCount (live register), the SDA
    // load source = ram[0x1D4428] (retraceCount), r13 (SDA base sanity).
    static u64 n = 0;
    auto& sys = Core::System::GetInstance();
    if (phase == 1) {
        auto& ps1 = sys.GetPPCState();
        NOTICE_LOG_FMT(POWERPC, "[ax-vwaitset] r3={:#x} r2={:#x} r13={:#x} lr={:#x}", ps1.gpr[3],
                       ps1.gpr[2], ps1.gpr[13], LR(ps1));
        return;
    }
    ++n;
    if (n > 64 && (n & 0x3FF) != 0) return;
    auto& ps = sys.GetPPCState();
    const u8* ram = sys.GetMemory().GetRAM();
    const u32 rcount = ram ? ((u32(ram[0x1D4428]) << 24) | (u32(ram[0x1D4429]) << 16) |
                              (u32(ram[0x1D442A]) << 8) | u32(ram[0x1D442B])) : 0;
    // Caller of VIWaitForRetrace: its prologue stores the caller LR at
    // [r1+0x14] (mflr r0; stw r0,4(r1); stwu r1,-0x10(r1) -> slot at +0x14).
    u32 caller = 0;
    if (ram) {
        const u32 sp = ps.gpr[1] & 0x01FFFFFFu;
        caller = (u32(ram[sp + 0x14]) << 24) | (u32(ram[sp + 0x15]) << 16) |
                 (u32(ram[sp + 0x16]) << 8) | u32(ram[sp + 0x17]);
    }
    u32 min_vc = 0, min_vcf = 0;
    if (ram) {
        min_vc  = (u32(ram[0x1D3B04]) << 24) | (u32(ram[0x1D3B05]) << 16) |
                  (u32(ram[0x1D3B06]) << 8) | u32(ram[0x1D3B07]);
        min_vcf = (u32(ram[0x1D3B00]) << 24) | (u32(ram[0x1D3B01]) << 16) |
                  (u32(ram[0x1D3B02]) << 8) | u32(ram[0x1D3B03]);
    }
    NOTICE_LOG_FMT(POWERPC,
                   "[ax-recheck] n={} r30={} mem_rcount={} caller={:#x} minVcount={} minVcountF={:#x}",
                   n, ps.gpr[30], rcount, caller, (s32)min_vc, min_vcf);
    (void)phase;
}

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
    // [ax-minvc2] per-store-block wild-store bracket for minimumVcount
    // (0x1D3B04): detection lands within ONE block of the writer.
    {
        auto& sys_m = Core::System::GetInstance();
        const u8* ram_m = sys_m.GetMemory().GetRAM();
        if (ram_m) {
            static u32 s_prev_mv2 = 0xEEEEEEEEu;
            u32 mv = (u32(ram_m[0x1D3B04]) << 24) | (u32(ram_m[0x1D3B05]) << 16) |
                     (u32(ram_m[0x1D3B06]) << 8) | u32(ram_m[0x1D3B07]);
            if (mv != s_prev_mv2) {
                auto& ps_m = sys_m.GetPPCState();
                NOTICE_LOG_FMT(POWERPC,
                               "[ax-minvc2] {:#x} -> {:#x} (block pc={:#x} lr={:#x})",
                               s_prev_mv2, mv, ps_m.pc, LR(ps_m));
                s_prev_mv2 = mv;
            }
        }
    }
    // [ax-fill] __fill_mem (0x800033D8..0x80003490) dominates wedged-phase
    // dispatch; check_exc never fires from its stw/bdnz loop, but this drain
    // runs at every store-block exit. Capture caller LR + args (r3=dst,
    // r4=fill, r5=size at entry) + CTR (remaining words).
    {
        auto& ps_f = Core::System::GetInstance().GetPPCState();
        if (ps_f.pc >= 0x800033D8 && ps_f.pc < 0x80003490) {
            static u64 s_fill_n = 0;
            const u64 fn = ++s_fill_n;
            if (fn <= 8 || (fn & 0x3FFF) == 0) {
                NOTICE_LOG_FMT(POWERPC, "[ax-fill] n={} pc={:#x} lr={:#x} r3={:#x} r4={:#x} r5={:#x} ctr={:#x}",
                               fn, ps_f.pc, LR(ps_f), ps_f.gpr[3], ps_f.gpr[4], ps_f.gpr[5], CTR(ps_f));
            }
        }
    }
    static u64 s_drain_n = 0;
    if ((++s_drain_n & 0xFFu) == 1) {
        NOTICE_LOG_FMT(POWERPC, "[ax-pe] dolphin_gather_drain n={}", s_drain_n);
    }
    // [pc-census] drain: every ~256K drains, if the ring is full, count
    // duplicates and log ONE line of the top entries, then re-arm. Each
    // window = 256 consecutive dispatches at the time the ring was open.
    if ((s_drain_n & 0x3FFFFu) == 2 && bemental::g_pc_census_n >= 256) {
        int vals[256];
        int cnts[256];
        int nuniq = 0;
        for (int i = 0; i < 256; ++i) {
            const int v = bemental::g_pc_census_ring[i];
            int j = 0;
            for (; j < nuniq; ++j) if (vals[j] == v) { cnts[j]++; break; }
            if (j == nuniq) { vals[nuniq] = v; cnts[nuniq] = 1; nuniq++; }
        }
        // selection-sort top 10 by count; translate handles -> guest PCs via
        // the same-thread JS map (values >= 0x80000000 are already PCs).
        std::string line;
        for (int k = 0; k < 10 && k < nuniq; ++k) {
            int best = k;
            for (int j = k + 1; j < nuniq; ++j) if (cnts[j] > cnts[best]) best = j;
            std::swap(cnts[k], cnts[best]);
            std::swap(vals[k], vals[best]);
            u32 pc = (u32)vals[k];
            if (pc < 0x80000000u) {
                const u32 mapped = (u32)EM_ASM_INT({
                    var m = Module.bemental_handle_to_pc;
                    var v = m && m[$0];
                    return (v === undefined) ? 0 : (v | 0);
                }, vals[k]);
                if (mapped) pc = mapped;
            }
            line += fmt::format(" {:x}x{}", pc, cnts[k]);
        }
        NOTICE_LOG_FMT(POWERPC, "[pc-census] total={} uniq={}{}",
                       bemental::g_pc_census_total, nuniq, line);
        bemental::g_pc_census_n = 0;
    }
    auto& system = Core::System::GetInstance();
    GPFifo::UpdateGatherPipe(system.GetGPFifo());
    // [ax-cp] every 4096th drain (after UpdateGatherPipe → GatherPipeBursted
    // → RunGpu has run), snapshot CP/FIFO state so we can see whether the
    // game's CP enables/disables vs CPReadWriteDistance evolution. The
    // wedge investigation question is: is the FIFO actually being parsed,
    // or is CPReadWriteDistance stuck at 0 because GPLinkEnable is false
    // (so GatherPipeBursted skips the CPWritePointer/distance update)?
    if ((s_drain_n & 0xFFFu) == 1) {
        auto& fifo = system.GetCommandProcessor().GetFifo();
        const u32 gp_link  = fifo.bFF_GPLinkEnable.load(std::memory_order_relaxed) ? 1u : 0u;
        const u32 gp_read  = fifo.bFF_GPReadEnable.load(std::memory_order_relaxed) ? 1u : 0u;
        const u32 bp_en    = fifo.bFF_BPEnable.load(std::memory_order_relaxed) ? 1u : 0u;
        const u32 dist     = fifo.CPReadWriteDistance.load(std::memory_order_relaxed);
        const u32 wptr     = fifo.CPWritePointer.load(std::memory_order_relaxed);
        const u32 rptr     = fifo.CPReadPointer.load(std::memory_order_relaxed);
        // POWERPC channel — the probe captures only N[PowerPC]: lines per
        // gamecube/tools/dolphin_render_probe.js, not COMMANDPROCESSOR.
        NOTICE_LOG_FMT(POWERPC,
                       "[ax-cp] state @drain={} gp_link={} gp_read={} bp_en={} "
                       "dist=0x{:x} wptr=0x{:x} rptr=0x{:x}",
                       s_drain_n, gp_link, gp_read, bp_en, dist, wptr, rptr);
    }
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

// CP/FIFO state snapshot for the wedge investigation. Returns a packed u32:
//   bit 0  : SCPFifoStruct::bFF_GPLinkEnable     (CP linked to gather pipe)
//   bit 1  : SCPFifoStruct::bFF_GPReadEnable     (CP read enabled)
//   bit 2  : SCPFifoStruct::bFF_BPEnable
//   bit 3  : 1 if CPReadWriteDistance != 0
//   bits 4..7   : reserved
//   bits 8..31  : CPReadWriteDistance >> 5 (truncated; full value via NOTICE)
// Also emits a NOTICE_LOG line so the full state is captured in the probe.
EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_get_cp_state() {
    auto& system = Core::System::GetInstance();
    auto& fifo = system.GetCommandProcessor().GetFifo();
    const u32 gp_link  = fifo.bFF_GPLinkEnable.load(std::memory_order_relaxed) ? 1u : 0u;
    const u32 gp_read  = fifo.bFF_GPReadEnable.load(std::memory_order_relaxed) ? 1u : 0u;
    const u32 bp_en    = fifo.bFF_BPEnable.load(std::memory_order_relaxed) ? 1u : 0u;
    const u32 dist     = fifo.CPReadWriteDistance.load(std::memory_order_relaxed);
    const u32 wptr     = fifo.CPWritePointer.load(std::memory_order_relaxed);
    const u32 rptr     = fifo.CPReadPointer.load(std::memory_order_relaxed);
    NOTICE_LOG_FMT(POWERPC,
                   "[ax-cp] state gp_link={} gp_read={} bp_en={} dist=0x{:x} "
                   "wptr=0x{:x} rptr=0x{:x}",
                   gp_link, gp_read, bp_en, dist, wptr, rptr);
    return (gp_link << 0) | (gp_read << 1) | (bp_en << 2) |
           ((dist != 0 ? 1u : 0u) << 3) |
           ((dist >> 5) << 8);
}

}  // extern "C"

#endif  // __EMSCRIPTEN__
