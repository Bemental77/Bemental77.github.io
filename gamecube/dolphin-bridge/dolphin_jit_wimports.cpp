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
#include "Core/HW/MMIO.h"
#include "Common/Swap.h"
#include "VideoCommon/CommandProcessor.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"

extern "C" {
extern unsigned char g_bem_promote_active;  // [xinst-fix] gate the promote drain past boot
}

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
extern "C" int g_dc_handover_done;  // defined in ProcessorInterface.cpp (sticky post-handover)
static inline void gp_dirty_check(uint32_t addr) {
    if ((addr & 0x0FFFFFFFu) == 0x0C008000u) {
        g_bem_gp_dirty = 1;
    }
}

// [slowmem-audit 2026-07-22 TEMP] bucket slow-path host calls by address class to find
// fastmem-eligible traffic that fell to the cross-instance slow trampoline (the PM19 boundary
// cost). @0x026B33B0 = RAM-mirror hits (top byte 0x00/0x80/0xC0, phys < 32MB — SHOULD be
// fastmem; a hit = classifier miss or non-armed store type), @0x026B33B4 = MMIO/other
// (legitimately slow), @0x026B33B8 = GP(0xCC008000, expected). Reads + writes share buckets.
static inline void slowmem_audit(uint32_t addr) {
    const uint32_t top = addr & 0xFE000000u;
    const uint32_t phys = addr & 0x03FFFFFFu;
    uintptr_t cell;
    if ((addr & 0x0FFFFFFFu) == 0x0C008000u) cell = 0x026B33B8u;
    else if ((top == 0x00000000u || top == 0x80000000u || top == 0xC0000000u) && phys < 0x02000000u)
        cell = 0x026B33B0u;   // RAM mirror — fastmem-eligible
    else if (top == 0xE0000000u)
        cell = 0x026B33BCu;   // locked-L1 cache — THP pixel-store candidate (PM23)
    else cell = 0x026B33B4u;  // MMIO / EFB / ARAM-mapped etc.
    volatile uint32_t* p = reinterpret_cast<volatile uint32_t*>(cell);
    *p = *p + 1u;
}

// [stateless-xlate 2026-07-21 — the dropped-VI-write root] Post-takeover, the WORKER owns guest
// execution and dolphin's mirrored ppc_state.MSR sits at whatever the last sync left it —
// including exception-entry windows with MSR.DR=0 (PC 0x500/0x900). MMU().Read/Write(EA)
// translate with THAT momentary state, so any mailbox MMIO op serviced during such a window
// failed ("Unable to resolve read/write address", ~4.4K/120s baseline): reads returned 0 and
// writes were SILENTLY DROPPED. Dropped per-frame VI XFB-flip writes are why dual-core
// presented a stale boot XFB forever (probe xfbAddr garbage 0x27cc27 vs single-exec's sane
// 0x1e6c00 — the frozen-Nintendo-logo screen). Post-takeover the GC address map is STATIC
// (BS2 BATs never change), so translate by ADDRESS SHAPE: strip the 0x8/0xC prefix, route
// MMIO pages via GetMMIOMapping (state-independent), access RAM directly (no icache concern:
// dolphin's JIT executes no guest code post-takeover). Pre-takeover keeps the MMU path
// EXACTLY — dolphin's own JIT needs BAT+icache semantics (the prior blanket-mask attempt
// broke DR=1 ops; see the 2026-06-04 note above). Exotic targets (EFB/L1/ARAM-mapped) fall
// back to the MMU path even post-takeover.
static inline bool worker_owns_cpu(void) {
    return *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026A0000u)) == 1u;
}
// (width-parameterized plain functions — this file's trampolines sit in an extern "C"
// block, where templates are not allowed.)
static bool stateless_read_w(uint32_t addr, uint32_t width, uint32_t* out) {
    auto& system = Core::System::GetInstance();
    // [lc-window PM23] locked-L1 [0xE0000000, 0xE0040000): direct backing-store
    // access (MMU.cpp:246-253 locked-L1 memcpy parity) — skips the full MMU
    // fallback for residual LC imports the emitter's in-wasm LC arm doesn't
    // cover. NOT gated on worker_owns_cpu(): the MMU path performs the IDENTICAL
    // ownership-independent memcpy for this range (no BAT/icache semantics).
    if ((addr & 0xFFFC0000u) == 0xE0000000u) {
        u8* const l1 = system.GetMemory().GetL1Cache();
        if (l1) {
            const u8* const pmem = l1 + (addr & 0x3FFFFu);
            if (width == 1u) { *out = pmem[0]; }
            else if (width == 2u) { u16 v; std::memcpy(&v, pmem, 2); *out = Common::swap16(v); }
            else { u32 v; std::memcpy(&v, pmem, 4); *out = Common::swap32(v); }
            return true;
        }
    }
    // Everything below is the post-takeover shape-routed path — pre-takeover
    // MUST keep exact MMU semantics (see the 2026-06-04 note above).
    if (!worker_owns_cpu()) return false;
    const uint32_t phys = addr & 0x3FFFFFFFu;
    if ((phys & 0x0FFF0000u) == 0x0C000000u) {
        MMIO::Mapping* const mmio = system.GetMemory().GetMMIOMapping();
        if (width == 1u) *out = mmio->Read<u8>(system, phys);
        else if (width == 2u) *out = mmio->Read<u16>(system, phys);
        else *out = mmio->Read<u32>(system, phys);
        return true;
    }
    auto& memory = system.GetMemory();
    if (phys + width <= memory.GetRamSizeReal()) {
        const u8* const pmem = memory.GetRAM() + phys;
        if (width == 1u) { *out = pmem[0]; }
        else if (width == 2u) { u16 v; std::memcpy(&v, pmem, 2); *out = Common::swap16(v); }
        else { u32 v; std::memcpy(&v, pmem, 4); *out = Common::swap32(v); }
        return true;
    }
    return false;
}
static bool stateless_write_w(uint32_t addr, uint32_t width, uint32_t val) {
    auto& system = Core::System::GetInstance();
    // [lc-window PM23] locked-L1 direct write — ownership-independent, see
    // stateless_read_w.
    if ((addr & 0xFFFC0000u) == 0xE0000000u) {
        u8* const l1 = system.GetMemory().GetL1Cache();
        if (l1) {
            u8* const pmem = l1 + (addr & 0x3FFFFu);
            if (width == 1u) { pmem[0] = (u8)val; }
            else if (width == 2u) { const u16 v = Common::swap16((u16)val); std::memcpy(pmem, &v, 2); }
            else { const u32 v = Common::swap32(val); std::memcpy(pmem, &v, 4); }
            return true;
        }
    }
    if (!worker_owns_cpu()) return false;
    const uint32_t phys = addr & 0x3FFFFFFFu;
    if ((phys & 0x0FFF0000u) == 0x0C000000u) {
        MMIO::Mapping* const mmio = system.GetMemory().GetMMIOMapping();
        if (width == 1u) mmio->Write<u8>(system, phys, (u8)val);
        else if (width == 2u) mmio->Write<u16>(system, phys, (u16)val);
        else mmio->Write<u32>(system, phys, val);
        return true;
    }
    auto& memory = system.GetMemory();
    if (phys + width <= memory.GetRamSizeReal()) {
        u8* const pmem = memory.GetRAM() + phys;
        if (width == 1u) { pmem[0] = (u8)val; }
        else if (width == 2u) { const u16 v = Common::swap16((u16)val); std::memcpy(pmem, &v, 2); }
        else { const u32 v = Common::swap32(val); std::memcpy(pmem, &v, 4); }
        return true;
    }
    return false;
}

EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_read8(uint32_t addr) {
    slowmem_audit(addr);
    uint32_t v;
    if (stateless_read_w(addr, 1u, &v)) return v;
    return Core::System::GetInstance().GetMMU().Read<u8>(addr);
}

EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_read16(uint32_t addr) {
    slowmem_audit(addr);
    uint32_t v;
    if (stateless_read_w(addr, 2u, &v)) return v;
    return Core::System::GetInstance().GetMMU().Read<u16>(addr);
}

EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_read32(uint32_t addr) {
    slowmem_audit(addr);
    uint32_t val;
    if (!stateless_read_w(addr, 4u, &val))
        val = Core::System::GetInstance().GetMMU().Read<u32>(addr);
    // [dual-core DSP/AI mask 2026-06-29] Hide INT_CAUSE_DSP(0x40)+AI(0x20) from the PI interrupt-
    // cause read (0xCC003000) so the worker's __OSDispatchInterrupt doesn't decode the unhandled
    // DSP/AI interrupt and overrun its unbounded prio loop. PHASE-GATED (CT_PHASE_FLAGS bit1 @
    // 0x0268002C): dolphin's OWN JitWasm CPU also reads MMIO through this trampoline during the
    // single-core boot-batch phase (bootLoop -> _run_iter_batch -> retro_run, Phase IV CLEAR),
    // where __OSDispatchInterrupt MUST see DSP or salInitDsp's `while(!salDspInitIsDone)` spins
    // forever (the DSP init-complete interrupt never reaches dspInitCallback -> black screen, no
    // handover). Only mask once the worker drives. Pairs with ProcessorInterface::UpdateException.
    if (addr == 0xCC003000u) {
        // Hide CP from the guest's cause read — the FIFO is host-pumped ([gpu-pump]);
        // the guest's CP handler has nothing to do.
        val &= ~0x800u;  // INT_CAUSE_CP
        const uint32_t pf =
            *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x0268002Cu));
        // [dual-core DSP/AI mask STICKY 2026-06-30] mask DSP/AI (0x60) from the dispatcher's cause
        // read once the worker has engaged — including the ISR excursion (Phase IV momentarily CLEAR).
        // g_dc_handover_done is the sticky flag set in ProcessorInterface::UpdateException.
        if (pf & 0x2u) g_dc_handover_done = 1;
        // [dsp-unhide A/B 2026-07-02] cause-read hide DISABLED alongside ProcessorInterface's
        // eff_cause hide: the post-audio-init guest has DSP/AI in its PI mask (0xffc) and NEEDS
        // the ARAM-DMA interrupt (aramStoreData wedge). See ProcessorInterface.cpp:UpdateException.
        // if ((pf & 0x2u) || g_dc_handover_done) val &= ~0x60u;
        // [cause-fastpath 2026-07-17] Keep this mirror FRESH so the worker can read the PI cause
        // WITHOUT a mailbox round-trip. The oracle proved the audio-init stall is THROUGHPUT: native
        // runs the ARAM ARQ-chain at ~400 DMAs/s and clears gc 156->214; the WASM guest manages ~2/s
        // because EVERY ISR MMIO read (cause 0xCC003000, DSP_CONTROL 0xCC00500A) is a blocking
        // worker->dolphin mailbox round-trip. The eager update is in ProcessorInterface::UpdateException
        // (runs on every cause change); this write covers the rare slow-path read too. Mirror @0x026B27D0.
        *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026B27D0u)) = val;
    }
    return val;
}

EMSCRIPTEN_KEEPALIVE
void dolphin_write8(uint32_t addr, uint32_t val) {
    gp_dirty_check(addr);
    slowmem_audit(addr);
    if ((addr & 0x0FFFFFFFu) == 0x0C008000u) {
        Core::System::GetInstance().GetGPFifo().Write8(static_cast<u8>(val));
        return;
    }
    if (stateless_write_w(addr, 1u, val)) return;
    Core::System::GetInstance().GetMMU().Write<u8>(static_cast<u8>(val), addr);
}

EMSCRIPTEN_KEEPALIVE
void dolphin_write16(uint32_t addr, uint32_t val) {
    gp_dirty_check(addr);
    slowmem_audit(addr);
    if ((addr & 0x0FFFFFFFu) == 0x0C008000u) {
        Core::System::GetInstance().GetGPFifo().Write16(static_cast<u16>(val));
        return;
    }
    if (stateless_write_w(addr, 2u, val)) return;
    Core::System::GetInstance().GetMMU().Write<u16>(static_cast<u16>(val), addr);
}

EMSCRIPTEN_KEEPALIVE
void dolphin_write32(uint32_t addr, uint32_t val) {
    gp_dirty_check(addr);
    slowmem_audit(addr);
    // [gp-direct 2026-07-07] GP writes bypass the MMU route: measured 85% loss between
    // MMU.Write and GPFifo::Write32 (gpW=374,733 vs gpFifoW=57,119) with the surviving
    // fragments never completing a 32B chunk — zero bursts, FIFO empty, GXDrawDone slept
    // forever. Direct routing guarantees ordered, lossless gather-pipe delivery.
    if ((addr & 0x0FFFFFFFu) == 0x0C008000u) {
        Core::System::GetInstance().GetGPFifo().Write32(val);
        return;
    }
    if (stateless_write_w(addr, 4u, val)) return;
    Core::System::GetInstance().GetMMU().Write<u32>(val, addr);
}

// [single-ordered-GX 2026-07-16 — RETIRED] dolphin_gp_seal/unseal were the Phase-IV-edge seal of
// the shared gather pipe. They are NO LONGER CALLED: the excursion-GX drop is now structural at the
// write site (GPFifo::gpfifo_reject_non_ring_gx gates on cpu_owner==1 && g_in_drain==0). Kept as
// inert stubs (KEEPALIVE) so any stale JS/C reference resolves, but they must NOT touch
// g_gp_discard — re-wiring the edge-toggle reintroduces the owner-clear splice race. Do not re-arm.
extern "C" int g_gp_discard;  // defined in GPFifo.cpp — post-takeover stays 0 (boot-era use only)
EMSCRIPTEN_KEEPALIVE
void dolphin_gp_seal() {
    // [single-ordered-GX 2026-07-16 — RETIRED] inert. The structural GPFifo::Write* reject replaced
    // this. Must not set g_gp_discard (the old edge-toggle + owner-clear was the splice race).
}
EMSCRIPTEN_KEEPALIVE
void dolphin_gp_unseal() {
    // [single-ordered-GX 2026-07-16 — RETIRED] inert.
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
extern "C" u32 g_in_cmd10 = 0;  // worker-requested delivery in progress (parked, safe)
uint32_t dolphin_check_exc(uint32_t /*unused*/) {
    g_in_cmd10 = 1;
    struct Cmd10Guard { ~Cmd10Guard() { g_in_cmd10 = 0; } } _cmd10_guard;
    auto& sys = Core::System::GetInstance();
    auto& ps = sys.GetPPCState();
    auto& ppc = sys.GetPowerPC();

    // [fp-eager A/B 2026-07-03] FP-unavailable -> set MSR.FP and RESUME (no vector). The
    // mbx/ffAt census caught the vectored path looping forever in OSDefaultExceptionHandler
    // with a garbage context (r3=7, r4="GMPE" = live junk, r1=0, srr1=0x30): the guest's
    // 0x800 slot is not a context-loading FPU stub, so every fp-check raise recursed on a
    // null stack (~470k mailbox calls/60s). Eager-FP trades lazy FP context-switch fidelity
    // (FPRs are still saved/restored by OSContext switches per the context's own flags) for
    // correctness-of-control-flow + throughput. Revisit with handler-presence detection if
    // FP state corruption appears.
    if (ps.Exceptions & EXCEPTION_FPU_UNAVAILABLE) {
        ps.msr.FP = 1;
        ps.Exceptions &= ~EXCEPTION_FPU_UNAVAILABLE;
        PowerPC::RoundingModeUpdated(ps);
        PowerPC::RecalculateAllFeatureFlags(ps);
        if ((ps.Exceptions) == 0)
            return 0;  // nothing else pending — resume the block path immediately
    }

    // [os-ready gate 2026-07-03 — the r1=0 orbit seed fix] NOTHING may vector until the OS
    // context pointer at MEM[0xC0] is a plausible cached-MEM1 pointer. seed-watch caught an
    // exception dispatched at gt=841 (earliest boot-dispatch) with MEM[0xC0] garbage: the
    // canonical vector stub loaded r4=junk, OSDefaultExceptionHandler ran on r1=0 forever
    // (~470k mailbox calls/60s). Generalizes the old EI-only 0xC0==0 suppression to ALL
    // delivery — pre-OSInit, native never vectors either.
    {
        const u8* ram0 = sys.GetMemory().GetRAM();
        u32 os_ctx = 0;
        if (ram0) {
            os_ctx = (u32(ram0[0xC0]) << 24) | (u32(ram0[0xC1]) << 16) |
                     (u32(ram0[0xC2]) << 8) | u32(ram0[0xC3]);
        }
        // Valid = nonzero PHYSICAL MEM1 pointer (the OS stores the context pointer at 0xC0
        // as physical: steady-state observed 0x001a5b38; the seed-era garbage was 0x074d5045).
        const bool os_ready = (os_ctx != 0u) && (os_ctx < 0x01800000u);
        if (!os_ready) {
            // OS not ready: hold the MASKABLE classes (EXT|DEC — they dispatch through the
            // OSContext-loading stubs and seeded the r1=0 orbit); let sync exceptions
            // (syscall etc.) through — the blanket hold starved boot to retired=2121.
            const u32 held = ps.Exceptions & (EXCEPTION_EXTERNAL_INT | EXCEPTION_DECREMENTER);
            ps.Exceptions &= ~(EXCEPTION_EXTERNAL_INT | EXCEPTION_DECREMENTER);
            const u32 pc0 = ps.pc;
            if (ps.Exceptions != 0)
                PowerPC::CheckExceptionsFromJIT(ppc);
            ps.Exceptions |= held;
            return (ps.pc != pc0) ? 1u : 0u;
        }
    }

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
            const u32 pc_before_supp = ps.pc;
            PowerPC::CheckExceptionsFromJIT(ppc);
            ps.Exceptions |= saved;
            return (ps.pc != pc_before_supp) ? 1u : 0u;
        }

        // Jit64 mtmsr "issue 4336": when the EI is caused by the Command
        // Processor (GPU FIFO), defer delivery so the next block runs and
        // feeds the FIFO rather than dispatching the EI vector. Matches
        // Jit_SystemRegisters.cpp:462-465.
        const u32 int_cause = sys.GetProcessorInterface().GetCause();
        if (int_cause & ProcessorInterface::INT_CAUSE_CP) {
            // [cp-hide 2026-07-06] CP is hidden from the guest (cause read masks 0x800);
            // deassert it host-side so a stuck watermark can't keep the PI cause hot, and
            // never defer on it — VI/SI/DSP deliveries proceed normally.
            Core::System::GetInstance().GetCommandProcessor().SetCPStatusFromCPU();
        }
    }

    // [post-op pc fix 2026-07-02 — SI-crash root, part 2] Report whether this call VECTORED
    // (pc changed to a handler). The per-op exception bail (gekko emit_exception_bail) emits
    // `if (ppc_check_exc(pc)) return ppc_state.pc;` — but this function returned 0
    // unconditionally, so the bail NEVER exited the block: after an in-call vectoring
    // (SRR0/MSR saved, pc=0x500) the block's REMAINING ops kept executing post-context-save,
    // and then re-ran after the handler's rfi. Non-idempotent ops (stwu/pops/update-forms)
    // corrupted r1/state — MP4's SI crash. Returning vectored=1 lets the bail exit
    // immediately, so the dispatcher re-enters at the handler and rfi resumes at the
    // post-op boundary (part 1: the bail now presents pc+4).
    const u32 pc_before = ps.pc;
    PowerPC::CheckExceptionsFromJIT(ppc);
    return (ps.pc != pc_before) ? 1u : 0u;
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
    // [hle-vector guard 2026-07-07] the 0x500 compile storm (slice acks: iters=4096==
    // compileCalls, lastPc=0x500 forever) matches this file's own documented HLE-check
    // loop class. Vector-page pcs are OS stubs — never HLE targets; skip the lookup
    // entirely.
    if (pc < 0x4000u) {
        return 0u;
    }
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
// [PM56 lazy-CR] The deferred-CR settle funnel: reconstruct eager cr[] from the
// shadow before the interp (which reads cr for mfcr/mtcrf/cr-logical/mcrf/
// mcrxr/isel/CR-bclr — all fall back here). bem_materialize_pending_cr is the
// single source of truth (bementalJIT cr_encode.cpp), takes the PowerPCState
// host base = the emitters' ctx_ptr.
extern "C" void bem_materialize_pending_cr(void* ctx_base);

void dolphin_interp(uint32_t /*inst*/, uint32_t pc) {
    // Pass-2 audit (w6oeq0l6e RANK 5): SingleStep() calls CoreTiming.Advance,
    // sets slice_length=1, forces downcount=0, and calls CheckExceptions —
    // all of which mutate state mid-block. SingleStepInner is the per-op-only
    // path that just executes one instruction. Mirrors Interpreter.cpp:263,278
    // FastRun pattern.
    auto& system = Core::System::GetInstance();
    auto& ppc_state = system.GetPPCState();
    if (ppc_state.pc != pc) return;
    // [msr-refresh 2026-07-10 — PERMANENT, the manufactured-ISI root] The worker's inline
    // EXT vectoring (ppc_worker.js STEP 2) mutates msr directly in the SAB (Atomics.store)
    // — dolphin's msr-DERIVED state (feature_flags, membase) is never recomputed, so the
    // next interpreter fallback fetched through a STALE translation context: the exception
    // stub's terminal rfi at vector+0x94 hit Read_Opcode(0x594/0x994) with IR=1 semantics
    // while the guest's msr.IR=0 -> BAT miss -> manufactured ISI (SRR1=0x40001030,
    // impossible on HW at IR=0) -> stub sees SRR1.RI=0 -> OSDefaultExceptionHandler ->
    // PPCHalt (the armframe-freeze face). Refresh here — the single funnel every
    // interpreter fallback shares; fallbacks are rare (~0% of JIT time, see below).
    system.GetPowerPC().MSRUpdated();
    // [perf gather-gate] An interp-stepped op may store to the gather pipe via
    // a path that does not go through dolphin_write* (belt-and-suspenders).
    // Interp fallback is rare (~0% of profiled JIT time), so conservatively
    // marking the FIFO dirty here costs nothing and removes the only way the
    // epilogue gate could miss a GP write.
    g_bem_gp_dirty = 1;
    // [PM56 lazy-CR] settle deferred CR fields to eager cr[] before the interp
    // reads them (mfcr/cr-logical/mcrf/isel/CR-bclr all route here).
    bem_materialize_pending_cr(&ppc_state);
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
    // [gate-8] Stripped stale [ax-minvc2]/[ax-fill]/[ax-card]/[ax-dbnc] per-drain
    // diagnostic blocks (RAM/MMU reads + pc-range checks ran on every block exit,
    // ~3.3% of JIT-worker self-time) for a clean throughput baseline.
    // [ax-pe] per-256-drain heartbeat removed 2026-06-13 (gate #8 clean
    // baseline): it was ~847 cross-thread postMessage prints/s, the dominant
    // diag overhead perturbing throughput measurement.
    auto& system = Core::System::GetInstance();
    // [xinst-fix] Open the promote gate once past boot: the region's re-emit/seal
    // cost only pays off in steady-state running, and running it during boot's
    // block-discovery stalls the path to a running state. Threshold in guest
    // ticks (env-overridable for tuning); default chosen to clear the apploader.
    if (!g_bem_promote_active)
    {
        static const u64 s_promote_after = []() -> u64 {
            const char* e = std::getenv("BJIT_PROMOTE_AFTER_TICKS");
            // [region-resident 2026-07-15] 5B ticks (~10s sim): past boot's
            // block-discovery, early enough that most of a run executes
            // promoted. The round-3 30B band-aid guarded ARRIVAL-ORDER
            // selection; the top-K windowed histogram now owns selection
            // quality, so activation can come down.
            return e ? static_cast<u64>(std::strtoull(e, nullptr, 10)) : 5000000000ull;
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
//   bits 8..31  : CPReadWriteDistance >> 5 (truncated)
EMSCRIPTEN_KEEPALIVE
uint32_t dolphin_get_cp_state() {
    auto& system = Core::System::GetInstance();
    auto& fifo = system.GetCommandProcessor().GetFifo();
    const u32 gp_link  = fifo.bFF_GPLinkEnable.load(std::memory_order_relaxed) ? 1u : 0u;
    const u32 gp_read  = fifo.bFF_GPReadEnable.load(std::memory_order_relaxed) ? 1u : 0u;
    const u32 bp_en    = fifo.bFF_BPEnable.load(std::memory_order_relaxed) ? 1u : 0u;
    const u32 dist     = fifo.CPReadWriteDistance.load(std::memory_order_relaxed);
    return (gp_link << 0) | (gp_read << 1) | (bp_en << 2) |
           ((dist != 0 ? 1u : 0u) << 3) |
           ((dist >> 5) << 8);
}

}  // extern "C"

#endif  // __EMSCRIPTEN__
