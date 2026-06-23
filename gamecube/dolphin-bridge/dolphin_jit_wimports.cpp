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
#include <cstdlib>  // [xinst-fix] getenv/strtoull for the promote-after-ticks gate
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
#include "Core/CoreTiming.h"
#include "Core/HW/EXI/EXI.h"          // [ax-card] EXI present check
#include "Core/HW/EXI/EXI_Channel.h"  // [ax-card] CEXIChannel::GetDevice
#include "Core/HW/EXI/EXI_Device.h"   // [ax-card] IEXIDevice::IsPresent
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
extern u32 g_chain_iters;
}
// [region-debug TEMP] region_dispatch outcome counters (block_cache.cpp).
extern "C" {
extern uint32_t g_rd_calls, g_rd_nohandle, g_rd_noregion, g_rd_miss, g_rd_hit, g_rd_nogen;
extern unsigned char g_bem_promote_active;  // [xinst-fix] gate the promote drain past boot
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

// [perf gather-gate] Set when a guest store targets the write-gather pipe
// (WPAR, phys 0x0C008000). The JIT block epilogue reads this WASM-side and
// only crosses to dolphin_gather_drain (the wasm->JS UpdateGatherPipe flush)
// when a GP write is actually pending — pure-compute store-blocks (the bulk)
// skip the crossing (~3.6% of JIT-worker self-time). Hang-proof: EVERY GP
// write path routes through dolphin_write{8,16,32}. This holds for BOTH
// integer and FP stores because the fastmem REGION CLASSIFIER (jit_load_store
// .cpp emit_fastmem_guard) admits only the RAM mirrors (EA & 0xFE000000 in
// {0x00,0x80,0xC0}000000) and routes WPAR (0xCC008000 / phys 0x0C008000 /
// mirrors) + all MMIO to the slow import arm — so stfs/stfsx (now fastmem-
// fast-armed) still reach dolphin_write32 for any GP target, and stfd/psq_st/
// lfd remain slowmem-only. dolphin_interp also sets the flag conservatively.
// The flag therefore can never miss a GP write and starve the FIFO.
extern "C" int g_bem_gp_dirty;   // defined in bementalJIT src/block_cache.cpp
static inline void gp_dirty_check(uint32_t addr) {
    if ((addr & 0x0FFFFFFFu) == 0x0C008000u) g_bem_gp_dirty = 1;
}

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
    gp_dirty_check(addr);
    Core::System::GetInstance().GetMMU().Write<u8>(static_cast<u8>(val), addr);
}

EMSCRIPTEN_KEEPALIVE
void dolphin_write16(uint32_t addr, uint32_t val) {
    gp_dirty_check(addr);
    Core::System::GetInstance().GetMMU().Write<u16>(static_cast<u16>(val), addr);
}

EMSCRIPTEN_KEEPALIVE
void dolphin_write32(uint32_t addr, uint32_t val) {
    gp_dirty_check(addr);
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

    // [gate-8] Stripped per-block-exit diagnostic preamble
    // ([ax-queue]/[ax-minvc]/[ax-pad]/[ax-gxdd]/[ax-park]/[ax-gates]/[ax-rcount]:
    // ~20 guest-RAM reads + change-logging that ran on EVERY block exit, the bulk
    // of dolphin_check_exc self-time). Real exception logic follows.

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
    // [perf gather-gate] An interp-stepped op may store to the gather pipe via
    // a path that does not go through dolphin_write* (belt-and-suspenders).
    // Interp fallback is rare (~0% of profiled JIT time), so conservatively
    // marking the FIFO dirty here costs nothing and removes the only way the
    // epilogue gate could miss a GP write.
    g_bem_gp_dirty = 1;
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
    // [gate-8] Stripped stale [ax-minvc2]/[ax-fill]/[ax-card]/[ax-dbnc] per-drain
    // diagnostic blocks (RAM/MMU reads + pc-range checks ran on every block exit,
    // ~3.3% of JIT-worker self-time) for a clean throughput baseline.
    // [ax-pe] per-256-drain heartbeat removed 2026-06-13 (gate #8 clean
    // baseline): it was ~847 cross-thread postMessage prints/s, the dominant
    // diag overhead perturbing throughput measurement.
    static u64 s_drain_n = 0;
    ++s_drain_n;
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
        // selection-sort top 22 by count; translate handles -> guest PCs via
        // the same-thread JS map (values >= 0x80000000 are already PCs).
        std::string line;
        for (int k = 0; k < 22 && k < nuniq; ++k) {
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
        NOTICE_LOG_FMT(POWERPC, "[pc-census] total={} chain={} ticks={} uniq={}{}",
                       bemental::g_pc_census_total, bemental::g_chain_iters,
                       Core::System::GetInstance().GetCoreTiming().GetTicks(), nuniq, line);
        NOTICE_LOG_FMT(POWERPC, "[region-dbg] calls={} hit={} miss={} nogen={}", g_rd_calls, g_rd_hit, g_rd_miss, g_rd_nogen);
        bemental::g_pc_census_n = 0;
    }
    auto& system = Core::System::GetInstance();
    // [xinst-fix] Open the promote gate once past boot: the region's re-emit/seal
    // cost only pays off in steady-state running, and running it during boot's
    // block-discovery stalls the path to a running state. Threshold in guest
    // ticks (env-overridable for tuning); default chosen to clear the apploader.
    if (!g_bem_promote_active)
    {
        static const u64 s_promote_after = []() -> u64 {
            const char* e = std::getenv("BJIT_PROMOTE_AFTER_TICKS");
            return e ? static_cast<u64>(std::strtoull(e, nullptr, 10)) : 150000000ull;
        }();
        if (system.GetCoreTiming().GetTicks() > s_promote_after)
            g_bem_promote_active = 1;
    }
    GPFifo::UpdateGatherPipe(system.GetGPFifo());
    // [perf gather-gate] Flushed all complete 32-byte chunks; any residual
    // (< 32 bytes) stays in the pipe buffer and needs no re-drain until the
    // next GP write re-arms the flag. Clear it so pure-compute store-blocks
    // skip the crossing until then.
    g_bem_gp_dirty = 0;
    // [ax-cp] per-4096-drain CP/FIFO snapshot removed 2026-06-13 (gate #8
    // clean baseline) — second-largest diag print source.
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
