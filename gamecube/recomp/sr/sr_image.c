// sr_image.c — WHOLE-IMAGE BOOT HOST LAYER for the SAB static recompiler.
//
// Everything before this file was a FIXTURE: one function (or one closure) staged
// from a native-Dolphin capture, run once, and diffed.  A fixture never executes
// `__start`, never touches a device register, and never needs a value that the
// hardware boot left in low memory — so none of that had to exist.  This file is
// the part that does: it stands `main.dol` up in a flat MEM1 the way BS2 + the
// apploader would have, and calls the translated entry point.
//
// ------------------------------------------------------------------ HONESTY RULE
// A host boundary function here is in exactly ONE of three states, and the state is
// machine-readable at run time through the boundary log:
//
//   IMG_D_REAL     implemented with the semantics the guest expects.  The SPR file,
//                  the timebase, the FPU context copy and the MSR family are real.
//   IMG_D_VOID     deliberately a no-op, because the thing it manages IS NOT
//                  MODELLED and therefore has nothing to do.  Every one of these is
//                  a cache-control function, and this runtime has a flat, coherent,
//                  un-cached MEM1 — `DCEnable` on a machine with no D-cache is not a
//                  fake, it is a tautology.  Each carries its reason inline.
//   IMG_D_UNIMPL   NOT IMPLEMENTED.  It FAULTS with SR_F_IMG_UNIMPL and its guest
//                  address is appended to the boundary log.  It does not return a
//                  plausible zero.
//
// That third state is the whole point.  `gamecube/recomp/`'s MP4 host layer resolved
// 127 of its 136 imports through `default: return 0`, and the visible consequence was
// that the port shipped with NO AUDIO AT ALL and nobody could see it from the inside.
// A silent stub is indistinguishable from a working one until a user notices; a
// faulting stub names itself the first time it is reached.
//
// ------------------------------------------------------------ WHAT THIS IS NOT
// This is not a GameCube.  With -DSR_MMIO the device-register window is a BACKING
// BUFFER (gekko_rt.h) with EXACTLY ONE modelled register: EXI CR's TSTART bit, which
// self-clears (see THE DEVICE BOUNDARY below, and note the falsifying control arm that
// ships with it).  Every other register in the window is memory: a read returns the last
// value written.  Nothing here completes a DVD transfer, advances a VI line counter, or
// delivers ANY interrupt — and the second of those matters more than it looks, because
// the guest's own device drivers wait on interrupt-cleared software flags as often as
// they poll a register.  Any boot that gets further because this window exists got
// further because it stopped FAULTING on a store, not because a device answered.
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <emscripten.h>
#include "gekko_rt.h"
#include "sr_host_os.h"

#ifndef SR_MMIO
#error "sr_image.c requires -DSR_MMIO. It implements gk_dev_read/gk_dev_write, which \
gekko_rt.h only declares and only calls under SR_MMIO, and it sizes its inventory from \
GK_HWREG_SIZE, which only exists there. build_image.sh passes it; this turns a confusing \
cascade of undeclared-identifier errors into one sentence."
#endif

// ------------------------------------------------------------------ from sr_driver.c
extern uint8_t  *g_ram;
extern uint32_t  g_ram_size;
extern uint32_t  g_fault;
extern int     (*sr_host_hook)(GekkoState *, uint32_t);
int          sr_dispatch(uint32_t addr, GekkoState *st);
int          sr_init(void);
GekkoState  *sr_state(void);
uint32_t     sr_call(uint32_t addr);
// from sr_host_os.c — EMSCRIPTEN_KEEPALIVE there, but sr_host_os.h declares only
// sr_host_call() and sr_os_init_irq(), so the MSR accessors are declared here.
void         sr_os_set_msr(uint32_t m);
uint32_t     sr_os_get_msr(void);

// ---------------------------------------------------------------- fault codes
// 0xC6 prefix — distinct from sr_extern (0xE0), sr_indirect (0xE1), sr_call (0xBAD0)
// and sr_host_os (0xC5), so a boot log can tell a missing BOOT stub apart from a
// missing translation and from a guest-OS refusal.
#define SR_F_IMG_UNIMPL   0xC6000000u   // reached a host address with no implementation
#define SR_F_IMG_NO_DOL   0xC6800001u   // sr_image_boot() before sr_image_load_dol()
#define SR_F_IMG_BAD_DOL  0xC6800002u   // DOL header did not parse

// ------------------------------------------------------------- the boundary log
// THE TRAJECTORY INSTRUMENT.  sr.py emits a direct guest `bl` as a direct C call, so
// there is no per-function hook to sample and no PC to poll — a wasm module cannot be
// interrupted from outside.  What IS observable is every crossing OUT of translated
// code: sr_driver.c routes each one through sr_host_hook, which is this file.  So the
// ordered list below is the exact sequence of host-boundary crossings from __start
// onward, and the fault that ends a run is the point the boot reached.  It is a
// BOUNDARY trajectory, not an instruction trace, and it must be reported as one.
#define IMG_LOG_CAP 16384
static uint32_t g_log[IMG_LOG_CAP * 2];   // [guest addr][disposition]
static uint32_t g_log_n = 0;
static uint32_t g_log_dropped = 0;

#define IMG_D_REAL    1
#define IMG_D_VOID    2
#define IMG_D_UNIMPL  3
#define IMG_D_OS      4   // handled by sr_host_os.c (the MSR / context / SelectThread set)

static void img_log(uint32_t addr, uint32_t disp) {
    if (g_log_n >= IMG_LOG_CAP) { g_log_dropped++; return; }
    g_log[2 * g_log_n] = addr;
    g_log[2 * g_log_n + 1] = disp;
    g_log_n++;
}

EMSCRIPTEN_KEEPALIVE uint32_t *sr_image_log(void)         { return g_log; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_log_n(void)       { return g_log_n; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_log_dropped(void) { return g_log_dropped; }
EMSCRIPTEN_KEEPALIVE void      sr_image_log_reset(void)   { g_log_n = 0; g_log_dropped = 0; }

// --------------------------------------------------------------- the SPR file
// Gekko supervisor SPRs the translated image cannot hold, because GekkoState models
// the USER-visible register set only (gekko_rt.h — GPR/FPR/CR/XER/LR/CTR/FPSCR/GQR/PC).
// Nothing here has architectural effect: HID0/HID2/L2CR/the BATs configure caches and
// address translation, and this runtime has neither.  They are stored and returned so
// that guest code which WRITES then READS one (DOLSDK does exactly this in
// __OSCacheInit and __OSPSInit) observes what it wrote instead of faulting.
static uint32_t g_spr[1024];
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_spr(uint32_t n)             { return g_spr[n & 1023u]; }
EMSCRIPTEN_KEEPALIVE void     sr_image_set_spr(uint32_t n, uint32_t v) { g_spr[n & 1023u] = v; }

// Gekko timebase.  OS_BUS_CLOCK/4 = 162 MHz / 4 = 40.5 MHz, and 675,000 ticks is
// exactly one 60 Hz frame — the same constant CLAUDE.md gate #9 names for the JIT's
// credit model.  THE GUEST CLOCK IS HOST WALL TIME, 1:1.  It is not scaled and it must
// never be: gate #9 makes speeding the guest up FORBIDDEN, and a timebase that runs
// fast IS speeding the guest up, whatever a frame counter reads afterwards.
// GK_TB_HZ is now ALSO defined by sr_host_os.h (as GK_CPU_HZ / GK_TIMER_RATIO) — the
// collision warned about at img_hook has already reached the macro level, and building
// this file emitted `'GK_TB_HZ' macro redefined`. Defer to the shared header rather than
// shadowing it: the two derivations agree at 40,500,000, and the day they DON'T is
// exactly the day a duplicate definition here would hide it. `/ 1000.0` forces the
// double arithmetic the header's unsigned constant would otherwise truncate.
#ifndef GK_TB_HZ
#define GK_TB_HZ 40500000u
#endif
static double g_tb_origin_ms = -1.0;
static uint64_t img_timebase(void) {
    double now = emscripten_get_now();
    if (g_tb_origin_ms < 0) g_tb_origin_ms = now;
    return (uint64_t)((now - g_tb_origin_ms) * ((double)GK_TB_HZ / 1000.0));
}

// --------------------------------------------------------------- OSContext layout
// ~/gc_refs/dolsdk2001/include/dolphin/os/OSContext.h.  The four offsets sr_host_os.h
// already carries (SRR0 408 = 0x198, SRR1 412, MODE 416, GQR0 420) pin the tail of the
// struct, and these three are the interior ones this file needs.
#define OSCTX_FPR(n)   ((uint32_t)(144u + (n) * 8u))   /* f64 fpr[32] @ 0x090 */
#define OSCTX_FPSCR    404u                            /* u32 fpscr    @ 0x194 */
#define OSCTX_PSF(n)   ((uint32_t)(456u + (n) * 8u))   /* f64 psf[32]  @ 0x1C8 */

static void img_w64(uint32_t ea, uint64_t v) {
    gk_w32(ea, (uint32_t)(v >> 32));
    gk_w32(ea + 4, (uint32_t)v);
}
static uint64_t img_r64(uint32_t ea) {
    return ((uint64_t)gk_r32(ea) << 32) | gk_r32(ea + 4);
}

// ============================================================ THE DEVICE BOUNDARY
//
// gekko_rt.h routes every guest access that lands in the 0xCC000000..0xCC008000
// hardware-register window here (see the DEVICE HOOKS block there).  Two jobs:
//
//   1. INVENTORY.  Record the first touch of every distinct register, read and write
//      separately.  A boot's device demand has never been measured on this path — the
//      fixtures never reach one — and "which registers does SAB's boot actually
//      touch, in what order" is the input to deciding what to model next.
//   2. ONE MODELLED DEVICE.  Exactly one register has behaviour, and it is named,
//      logged, and switchable.  Everything else is a backing buffer and is reported
//      as one.
//
// THE ONE MODELLED REGISTER, and why it is not a fake.  Measured 2026-09-04 against
// the whole-image build (wasm md5 0464002e92cecfaa3c1202484286249b): with the window
// as pure memory, `sr_image_call(0x800e362c)` (OSInit) never returns.  Walking OSInit's
// callees located it exactly — 0x800e9778 (`__OSReadROM`, the SRAM read) -> EXIImm
// (0x800e60ac) starts a transfer, then EXISync (0x800e6494) spins on:
//
//     800e6678  lwz    r0, 12(r31)          ; software channel state, MEM1 0x802CA88C
//     800e667c  rlwinm r0, r0, 0, 29, 29    ; bit 0x4 = "transfer pending"
//     800e6680  bne    0x800e64cc
//     800e64cc  lwz    r0, 12(r29)          ; EXI CR, MMIO 0xCC006800 + ch*0x14 + 0x0C
//     800e64d0  rlwinm r0, r0, 0, 31, 31    ; bit 0x1 = TSTART
//     800e64d4  bne    0x800e6678           ; ...forever
//
// On hardware the EXI controller clears TSTART when the transfer completes.  Modelling
// it as SELF-CLEARING is modelling an EXI device with zero latency — a statement about
// timing, not about data.  It is the whole model; it invents no bytes.  What it does
// NOT do is deliver the EXI completion INTERRUPT, so anything that waits for the
// interrupt rather than polling CR is still blocked, and SRAM still reads back as the
// zeros the buffer holds.  Both of those are visible in the inventory rather than
// hidden by it.  `sr_image_set_exi_model(0)` turns the model off, which restores the
// wedge exactly — that is the falsifying control arm for any claim that it helped.
#define EXI_BASE      0xCC006800u
#define EXI_CHAN_SZ   0x14u
#define EXI_CR_OFF    0x0Cu
#define EXI_CR_TSTART 0x00000001u

static uint8_t  g_dev_seen_rd[GK_HWREG_SIZE];
static uint8_t  g_dev_seen_wr[GK_HWREG_SIZE];
static uint32_t g_dev_rd_n = 0, g_dev_wr_n = 0;   // total accesses, not distinct
static uint32_t g_exi_model = 1;
static uint32_t g_exi_clears = 0;
static uint32_t g_watchdog = 0;                   // 0 = off

#define DEV_LOG_CAP 512
static uint32_t g_dev_log[DEV_LOG_CAP * 2];       // [guest addr][1=read 2=write 3=EXI-model]
static uint32_t g_dev_log_n = 0;

static void dev_log(uint32_t ea, uint32_t kind) {
    if (g_dev_log_n >= DEV_LOG_CAP) return;
    g_dev_log[2 * g_dev_log_n] = ea;
    g_dev_log[2 * g_dev_log_n + 1] = kind;
    g_dev_log_n++;
}

// THE WATCHDOG.  A guest that spins on a device register cannot be stopped from
// outside: sr.py's output is straight-line C, this build has no -pthread, and a wasm
// module has no interrupt.  A run that wedges therefore posts NO log at all and the
// whole run yields nothing — which is exactly what the first OSInit probe produced,
// 100 recorded boundary crossings none of which were readable.  Throwing a JS
// exception out of the module is the one available exit, and it leaves linear memory
// (and so both logs) intact for the harness to read afterwards.
static void dev_watchdog(void) {
    EM_ASM({ throw new Error('sr_image watchdog: ' + $0 + ' device accesses without returning' +
                             ' — the guest is spinning on a device register'); }, g_dev_rd_n);
}

void gk_dev_read(uint32_t p, uint32_t n) {
    uint32_t off = p - GK_HWREG_OFF;
    if (off >= GK_HWREG_SIZE) return;
    g_dev_rd_n++;
    if (!g_dev_seen_rd[off]) { g_dev_seen_rd[off] = 1; dev_log(GK_HWREG_LO + off, 1); }
    if (g_watchdog && g_dev_rd_n > g_watchdog) dev_watchdog();
}

void gk_dev_write(uint32_t p, uint32_t n) {
    uint32_t off = p - GK_HWREG_OFF;
    if (off >= GK_HWREG_SIZE) return;
    g_dev_wr_n++;
    if (!g_dev_seen_wr[off]) { g_dev_seen_wr[off] = 1; dev_log(GK_HWREG_LO + off, 2); }
    if (!g_exi_model) return;
    // EXI CR of any of the three channels, written with TSTART set: complete instantly.
    uint32_t ea = GK_HWREG_LO + off;
    if (ea >= EXI_BASE && ea < EXI_BASE + 3u * EXI_CHAN_SZ &&
        ((ea - EXI_BASE) % EXI_CHAN_SZ) == EXI_CR_OFF) {
        // RAW buffer access, NOT gk_r32/gk_w32.  Those route back through GK_RD/GK_WPOST,
        // i.e. straight back into this function — gk_w32 here is unbounded recursion, and
        // gk_r32 would double-count every device read in the inventory.  The hook must
        // never re-enter the hooked path.
        uint8_t *r = g_ram + p;
        uint32_t cr = ((uint32_t)r[0] << 24) | ((uint32_t)r[1] << 16) |
                      ((uint32_t)r[2] << 8)  | r[3];
        if (cr & EXI_CR_TSTART) {
            cr &= ~EXI_CR_TSTART;
            r[0] = (uint8_t)(cr >> 24); r[1] = (uint8_t)(cr >> 16);
            r[2] = (uint8_t)(cr >> 8);  r[3] = (uint8_t)cr;
            g_exi_clears++;
            dev_log(ea, 3);
        }
    }
}

EMSCRIPTEN_KEEPALIVE uint32_t *sr_image_dev_log(void)   { return g_dev_log; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_dev_log_n(void) { return g_dev_log_n; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_dev_reads(void) { return g_dev_rd_n; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_dev_writes(void){ return g_dev_wr_n; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_exi_clears(void){ return g_exi_clears; }
// The falsifying control arm: 0 restores the pure-backing-buffer behaviour, so a claim
// that the EXI model unblocked something must FAIL with it off.
EMSCRIPTEN_KEEPALIVE void      sr_image_set_exi_model(uint32_t on) { g_exi_model = on; }
EMSCRIPTEN_KEEPALIVE void      sr_image_set_watchdog(uint32_t n)   { g_watchdog = n; }

// ------------------------------------------------------------------ the DOL image
static uint32_t g_dol_entry = 0;
static int      g_dol_loaded = 0;

static uint32_t be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

// LOW-MEMORY OS GLOBALS.  On real hardware BS2 (the IPL's second stage) writes these
// before it hands control to the apploader, and the apploader writes a few more before
// it branches to the DOL entry.  A static recomp has neither, so the host synthesizes
// them.  Every value below is cited; anything NOT cited is left at the zero calloc
// already guarantees, rather than invented — a wrong non-zero here is far worse than a
// zero, because the guest will act on it.
static void img_os_globals(void) {
    // Written from sr_image_set_global() by the JS boot layer, which carries the
    // citations (see build_image.sh / sr_image_worker.js).  Kept as a hook rather
    // than a hardcoded table so a value can be corrected without a 33 MB relink.
}
EMSCRIPTEN_KEEPALIVE void sr_image_set_global(uint32_t ea, uint32_t v) { gk_w32(ea, v); }

EMSCRIPTEN_KEEPALIVE uint32_t sr_image_entry(void) { return g_dol_entry; }

// Parse a DOL in a host buffer and lay its sections into MEM1 at their link addresses.
// This is the apploader's job (DOLSDK does not ship one; Dolphin's Boot.cpp does the
// same thing when it boots a .dol directly).
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_load_dol(const uint8_t *dol, uint32_t len) {
    if (!sr_init()) return SR_F_IMG_BAD_DOL;
    if (!dol || len < 0x100) return SR_F_IMG_BAD_DOL;

    uint32_t toff[7], tadr[7], tsz[7], doff[11], dadr[11], dsz[11];
    for (int i = 0; i < 7; i++)  { toff[i] = be32(dol + 0x00 + 4 * i);
                                   tadr[i] = be32(dol + 0x48 + 4 * i);
                                   tsz[i]  = be32(dol + 0x90 + 4 * i); }
    for (int i = 0; i < 11; i++) { doff[i] = be32(dol + 0x1c + 4 * i);
                                   dadr[i] = be32(dol + 0x64 + 4 * i);
                                   dsz[i]  = be32(dol + 0xac + 4 * i); }
    uint32_t bss_addr = be32(dol + 0xd8), bss_size = be32(dol + 0xdc);
    uint32_t entry    = be32(dol + 0xe0);
    if (entry < 0x80000000u || entry >= 0x81800000u) return SR_F_IMG_BAD_DOL;

    // BSS FIRST, THEN THE SECTIONS, and the order is load-bearing for THIS disc:
    // SAB's BSS is 0x801de600 + 0x1cff15 = 0x803ae515, while DATA4 links at 0x803ad2c0
    // and DATA5 at 0x803ae520 — DATA4 lies INSIDE the BSS range.  A memset issued
    // after the copy would erase it.  (Zero-then-copy is also the order the apploader
    // uses, so this is not a workaround for an unusual link.)
    if (bss_size) {
        uint32_t p = gk_phys(bss_addr);
        if (p + bss_size <= g_ram_size) memset(g_ram + p, 0, bss_size);
    }
    uint32_t copied = 0;
    for (int i = 0; i < 7; i++) {
        if (!tsz[i] || (uint64_t)toff[i] + tsz[i] > len) continue;
        uint32_t p = gk_phys(tadr[i]);
        if (p + tsz[i] > g_ram_size) continue;
        memcpy(g_ram + p, dol + toff[i], tsz[i]); copied += tsz[i];
    }
    for (int i = 0; i < 11; i++) {
        if (!dsz[i] || (uint64_t)doff[i] + dsz[i] > len) continue;
        uint32_t p = gk_phys(dadr[i]);
        if (p + dsz[i] > g_ram_size) continue;
        memcpy(g_ram + p, dol + doff[i], dsz[i]); copied += dsz[i];
    }
    img_os_globals();
    g_dol_entry = entry;
    g_dol_loaded = 1;
    return copied;
}

// ------------------------------------------------------------- the host stubs
//
// SAB's own boot path, disassembled from the shipped bytes
// (`python3 tools/disasm_fn.py --iso <sab.iso> --pc 0x80003140 --size 0x130`):
//
//   0x80003140 __start
//     bl 0x80003254   __init_registers   r1=0x803c1450 r2=0x803b6520 r13=0x803b52c0
//     bl 0x80003330   __init_hardware    <- HOST, below
//     bl 0x80003270   __init_data        .data copy + .bss clear loops
//     ...             reads 0x800000f4; NON-ZERO there is the DEBUGGER path (mtlr/bclrl)
//     bl 0x800ecf08   OSInit
//     bl 0x800e362c
//     bl 0x800d3ad0   main
//     b  0x8010b458
static int img_host(GekkoState *st, uint32_t addr) {
    switch (addr) {

    // ---- 0x80003330 __init_hardware.  Shipped bytes:
    //   7c0000a6 mfmsr r0 / 60002000 ori r0,r0,0x2000 / 7c000124 mtmsr r0
    //   7fe802a6 mflr r31 / bl 0x800e3d38 / bl 0x800e5294 / 7fe803a6 mtlr r31 / blr
    // MSR[FP] (0x2000) is set, then the paired-single and cache initialisers run.  Both
    // calls are RE-ISSUED rather than approximated: 0x800e3d38 is another host stub
    // below, and 0x800e5294 is TRANSLATED, so it goes through sr_dispatch and executes
    // the guest's own code.
    case 0x80003330u: {
        sr_os_set_msr(sr_os_get_msr() | 0x2000u);
        img_log(addr, IMG_D_REAL);
        if (!img_host(st, 0x800e3d38u)) { g_fault = SR_F_IMG_UNIMPL | 0x0e3d38u; return 1; }
        if (!sr_dispatch(0x800e5294u, st)) { g_fault = SR_F_IMG_UNIMPL | 0x0e5294u; return 1; }
        return 1;
    }

    // ---- 0x800e3d38 __OSPSInit.  "mtspr SPR912" in the skip list: SPR912..919 are
    // GQR0..GQR7 and SPR920 is HID2.  DOLSDK's __OSPSInit sets HID2[PSE|LSQE] and
    // clears every GQR to the default (type 0 = FLOAT, scale 0) — which is exactly the
    // mode gekko_rt.h's psq_l/psq_st implement, and the ONLY one: the runtime sets
    // g_fault = 0xDEAD0001/0xDEAD0002 on any other GQR type.  Clearing them is
    // therefore not a convenience, it is the state the translated paired-single code
    // requires in order to be correct at all.
    case 0x800e3d38u: {
        for (int i = 0; i < 8; i++) st->gqr[i] = 0;
        g_spr[920] = (1u << 30) | (1u << 29);   // HID2: PSE | LSQE
        img_log(addr, IMG_D_REAL);
        return 1;
    }

    // ---- the PPCMf*/PPCMt* SPR accessors (0x800e34a4..0x800e34f0).  Each is two
    // instructions — `mfspr rD,N; blr` or `mtspr N,rS; blr` — serviced against the host
    // SPR file.  The SPR NUMBER is not visible from the call address, so it is DECODED
    // FROM THE SHIPPED INSTRUCTION WORD in guest memory: reading the machine instead of
    // hardcoding a table that can drift out from under the binary.  (Same discipline as
    // README §5h "ask the guest OS, do not scan for it".)
    case 0x800e34a4u: case 0x800e34acu: case 0x800e34b4u: case 0x800e34bcu:
    case 0x800e34e0u: case 0x800e34e8u: case 0x800e34f0u: {
        uint32_t w   = gk_r32(addr);
        uint32_t xo  = (w >> 1) & 0x3ffu;
        uint32_t spr = ((w >> 16) & 0x1fu) | (((w >> 11) & 0x1fu) << 5);
        uint32_t rt  = (w >> 21) & 0x1fu;
        if      (xo == 339u) st->gpr[rt] = g_spr[spr & 1023u];   // mfspr
        else if (xo == 467u) g_spr[spr & 1023u] = st->gpr[rt];   // mtspr
        else { img_log(addr, IMG_D_UNIMPL);
               if (!g_fault) g_fault = SR_F_IMG_UNIMPL | (addr & 0x00ffffffu);
               return 1; }
        img_log(addr, IMG_D_REAL);
        return 1;
    }

    // ---- CACHE CONTROL — IMG_D_VOID, and the reason is structural rather than a
    // shortcut: this runtime's MEM1 is one flat host buffer with no cache in front of
    // it and no address translation (gekko_rt.h masks 26 bits and indexes it
    // directly).  Enabling, disabling, flushing, storing or invalidating a cache that
    // does not exist has no state to change, so a no-op is the FULL semantics here, not
    // an approximation of them.  Two sub-classes are folded in for the same reason:
    // 0x800e34c4 / 0x800e4e4c / 0x800e4e80 reach the same operations through `sc`, and
    // 0x800e4f70 __LCEnable / 0x800e5074 LCDisable manage the LOCKED cache, which
    // README §5k established is ORDINARY MEMORY here and is already backed by the tail
    // buffer whether or not it has been "enabled".
    //
    // ⚠ THE ONE THING THIS DOES NOT COVER: a guest that uses DCFlushRange to publish a
    // buffer to a DMA engine is relying on an ordering this runtime cannot violate
    // (there is one memory), but a guest that uses DCInvalidateRange to RE-READ a
    // buffer a DMA engine wrote is relying on the DMA having happened — and no DMA
    // engine is modelled.  That failure surfaces as wrong data, not as a fault here.
    case 0x800e34c4u:   // PPCSync                (sc)
    case 0x800e4e08u:   // DCEnable
    case 0x800e4e1cu:   // cache/sync op x470
    case 0x800e4e4cu:   // DCFlushRange-class     (sc)
    case 0x800e4e80u:   // DCStoreRange-class     (sc)
    case 0x800e4f4cu:   // ICFlashInvalidate
    case 0x800e4f5cu:   // ICEnable
    case 0x800e4f70u:   // __LCEnable
    case 0x800e5074u:   // LCDisable
    case 0x8014b504u:   // cache/sync op x470
    case 0x8014b5bcu:   // cache/sync op x470
    case 0x8014b680u:   // cache/sync op x470
    case 0x8014b7acu:   // cache/sync op x470
        img_log(addr, IMG_D_VOID);
        return 1;

    // ---- 0x800ecb48 OSGetTime / 0x800ecb60 OSGetTick.  `op31 xo=371` is mftb.  Both
    // are REAL: they return the host monotonic clock converted at 40.5 MHz, so guest
    // elapsed time equals host elapsed time exactly (see the gate-#9 note above the
    // timebase).  OSGetTime returns the 64-bit tick in r3:r4 (high:low); OSGetTick
    // returns the low 32 in r3.
    case 0x800ecb48u: { uint64_t t = img_timebase();
                        st->gpr[3] = (uint32_t)(t >> 32); st->gpr[4] = (uint32_t)t;
                        img_log(addr, IMG_D_REAL); return 1; }
    case 0x800ecb60u: { st->gpr[3] = (uint32_t)img_timebase();
                        img_log(addr, IMG_D_REAL); return 1; }

    // ---- 0x800e54ac __OSSaveFPUContext / 0x800e5388 __OSLoadFPUContext.  Skipped by
    // the translator only for their `mfspr SPR920` (HID2) probe of whether the
    // paired-single unit is on; the body is a straight stfd/lfd of 32 FPRs plus the
    // FPSCR, and — because HID2[PSE] is set by __OSPSInit above — also the 32 PS1
    // slots into psf[].  GekkoState carries ps0[]/ps1[] as raw binary64 bits, which is
    // the same representation OSContext stores, so this is a copy and not a
    // conversion.  r3 = OSContext*.
    case 0x800e54acu: {   // save: context <- registers
        uint32_t ctx = st->gpr[3];
        for (int i = 0; i < 32; i++) img_w64(ctx + OSCTX_FPR(i), st->ps0[i]);
        for (int i = 0; i < 32; i++) img_w64(ctx + OSCTX_PSF(i), st->ps1[i]);
        gk_w32(ctx + OSCTX_FPSCR, st->fpscr);
        img_log(addr, IMG_D_REAL);
        return 1;
    }
    case 0x800e5388u: {   // load: registers <- context
        uint32_t ctx = st->gpr[3];
        for (int i = 0; i < 32; i++) st->ps0[i] = img_r64(ctx + OSCTX_FPR(i));
        for (int i = 0; i < 32; i++) st->ps1[i] = img_r64(ctx + OSCTX_PSF(i));
        st->fpscr = gk_r32(ctx + OSCTX_FPSCR);
        img_log(addr, IMG_D_REAL);
        return 1;
    }

    default:
        return 0;
    }
}

// The single hook sr_driver.c calls.  ORDER MATTERS: the boot layer is asked FIRST so
// it can own __init_hardware and the SPR file, and sr_host_os.c is asked SECOND for the
// MSR / context / SelectThread set it already owns (sr_host_os.h).
//
// ⚠ COLLISION WATCH, and it is live as of 2026-09-04.  As written, the two layers claim
// disjoint addresses — but `sr_host_os.h` has just grown SR_EV_GET_TIME / SR_EV_GET_TICK
// / SR_EV_SET_DEC and an `sr_tb_*` guest timebase, i.e. a second implementation of
// OSGetTime / OSGetTick, which THIS file already answers at 0x800ecb48 / 0x800ecb60.
// `sr_host_os.c` does not implement them yet (verified: no match for `sr_tb_` in it), so
// nothing is wrong today.  The moment it does, THIS LAYER SILENTLY WINS because it is
// asked first, and a guest clock believed to come from the shared, decrementer-aware
// implementation would actually be coming from the four lines below.  When that lands,
// delete this file's two clock cases rather than reordering the hook — sr_host_os.c is
// the layer that also owns the decrementer and the stall fault, and a clock split across
// two owners is how a timing bug becomes unattributable.
//
// This hook ALWAYS returns 1 — including for an address nobody implements.  That is
// deliberate: returning 0 would send control back into sr_extern(), which would set the
// generic 0xE0 code and lose which of the two layers refused.  The 0xC6 fault plus the
// IMG_D_UNIMPL log entry names the address instead.
// TWO ARMS, and they answer different questions.  Both LOG every crossing; neither
// silently fakes one.
//   permissive (default)  an unimplemented boundary is logged and returns to the guest.
//                         ONE run enumerates the whole boundary demand of a boot, which
//                         matters because a rebuild here is a 33 MB translation unit.
//                         The guest then runs on garbage — say so when quoting it.
//   strict                the first unimplemented boundary throws out of the module and
//                         names itself.  Answers "what is the next thing to build?".
static uint32_t g_strict = 0;
EMSCRIPTEN_KEEPALIVE void sr_image_set_strict(uint32_t on) { g_strict = on; }

static int img_hook(GekkoState *st, uint32_t addr) {
    if (img_host(st, addr)) return 1;
    if (sr_host_call(st, addr)) { img_log(addr, IMG_D_OS); return 1; }
    img_log(addr, IMG_D_UNIMPL);
    if (!g_fault) g_fault = SR_F_IMG_UNIMPL | (addr & 0x00ffffffu);
    if (g_strict)
        EM_ASM({ throw new Error('sr_image strict: unimplemented host boundary at 0x' +
                                 ($0 >>> 0).toString(16)); }, addr);
    return 1;
}

// ------------------------------------------------------------------ the boot
EMSCRIPTEN_KEEPALIVE int sr_image_init(void) {
    if (!sr_init()) return 0;
    sr_os_init_irq();      // installs sr_host_os.c's hook and sets SR_OS_IRQ
    sr_host_hook = img_hook;   // ...then take it over, chaining to it (img_hook above)
    return 1;
}

// Run the guest from the DOL entry point.  RETURNS ONLY WHEN THE GUEST RETURNS OR
// FAULTS — sr.py's output is straight-line C in which a guest `bl` is a host call, so
// there is no way to interrupt it from outside.  A guest that reaches its own main loop
// does not come back, which is why the caller must run this on a worker thread and read
// the boundary log from the main thread through the SAB rather than waiting on a
// return value.
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_boot(void) {
    if (!g_dol_loaded) return SR_F_IMG_NO_DOL;
    g_fault = 0;
    return sr_call(g_dol_entry);
}

// Run ONE translated function by guest address, for bring-up: it makes "does __start's
// first callee work?" answerable without committing to a run that never returns.
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_call(uint32_t addr) {
    g_fault = 0;
    return sr_call(addr);
}

EMSCRIPTEN_KEEPALIVE uint32_t sr_image_fault(void) { return g_fault; }
