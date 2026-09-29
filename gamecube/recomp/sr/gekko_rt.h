// gekko_rt.h — Gekko (PowerPC 750CL) semantics runtime for the STATIC RECOMPILER.
//
// This is the fixed, game-independent half of `sr.py`'s output: the translator emits
// straight-line C that calls these helpers, one call per guest instruction semantic.
//
// EVERY numeric helper here is a behaviour-for-behaviour port of Dolphin's REFERENCE
// INTERPRETER, cited to file:line in ~/gc_refs/dolphin (pristine clone e22551e):
//   Force25Bit                 Interpreter/Interpreter_FPUtils.h:90
//   ForceSingle                Interpreter/Interpreter_FPUtils.h:52
//   NI_mul                     Interpreter/Interpreter_FPUtils.h:143
//   NI_madd_msub<sub,single>   Interpreter/Interpreter_FPUtils.h:285  (the 2Sum tie-fix)
//   psq_l  / Helper_Dequantize Interpreter/Interpreter_LoadStorePaired.cpp:218
//   psq_st / Helper_Quantize   Interpreter/Interpreter_LoadStorePaired.cpp:144
//   lfd / stfd                 Interpreter/Interpreter_LoadStore.cpp:63,363
//   ConvertToDouble            Common/FloatUtils.h  (single->double bit expansion)
//
// Deliberately NOT modelled (they are host-layer / not reached by leaf math code):
//   FPSCR exception bits, FPRF, CR1 (Rc=1 on FP), alignment/DSI exceptions,
//   the NI (non-IEEE) FPSCR mode.  Guarded: sr.py refuses to translate any
//   instruction with Rc=1 in the FP forms, and GQR modes other than FLOAT abort.
#ifndef GEKKO_RT_H
#define GEKKO_RT_H

#include <stdint.h>
#include <string.h>
#include <math.h>

// ---------------------------------------------------------------- guest state
typedef struct {
    uint32_t gpr[32];
    uint64_t ps0[32];      // FPR PS0 slot, raw IEEE-754 binary64 bits (as Dolphin stores it)
    uint64_t ps1[32];      // FPR PS1 slot
    uint32_t cr;           // 8 x 4-bit fields, CR0 in the HIGH nibble (PowerPC order)
    uint32_t xer;
    uint32_t lr;
    uint32_t ctr;
    uint32_t fpscr;
    uint32_t gqr[8];
    uint32_t pc;
} GekkoState;

// Guest RAM window. MEM1 is 24 MB at 0x80000000 (mirrored 0xC0000000); the
// recompiled code only ever sees physical offsets, so mask to 26 bits and index a
// flat host buffer. `g_ram_size` bounds every access (a fault sets g_fault).
extern uint8_t *g_ram;
extern uint32_t g_ram_size;
extern uint32_t g_fault;      // 0 = clean; else the guest address that faulted

// HID0 (SPR 1008).  ONE owner, for the same reason there is exactly one clock
// (sr_tb_read): the guest reads it back through PPCMfhid0 and the `sc` vector reads
// it, so two copies would be two answers.  Defined in sr_driver.c; sr_image.c's SPR
// accessor routes SPR 1008 here instead of into its private g_spr[].
// The initial value is the one the GameCube's BS2 leaves and the one the differential
// ORACLE therefore has: Dolphin Boot_BS2Emu.cpp:85 "HID0 is 0x0011c464 on GC",
// SetupHID setting BHT|BTIC|DCFA|DCFI|DCE|ICE|NHR|DPM (:86-97).
#define GK_HID0_BOOT   0x0011c464u
#define GK_HID0_ABE    0x00000008u   /* address broadcast; the `sc` vector pulses it */
extern uint32_t g_hid0;

// ====================================================================== THE DRIVE
// RETIRED GUEST CPU CYCLES -- the ONE input to guest time, and the reason gate #9
// can be met by a static recompiler at all.
//
// Dolphin derives the guest timebase from `CoreTiming::GetTicks()`, which is the
// EMULATED CPU CYCLE COUNTER, divided by TIMER_RATIO=12 (SystemTimers.cpp:213-218,
// SystemTimers.h:41).  That counter is fed one instruction at a time: the
// interpreter returns `opinfo->num_cycles` per instruction (Interpreter.cpp:193)
// and the JIT accumulates the same field per instruction into the block's downcount
// (Jit64/Jit.cpp:1003).  `g_gk_cycles` is that counter, and gk_retire() is that
// feed -- sr.py --retire emits ONE call per BASIC BLOCK carrying the summed
// num_cycles of the instructions in it, which is exactly the JIT's granularity.
//
// WHY THIS AND NOT A WALL CLOCK, in one line: this makes the guest's time:work
// ratio a constant of the GUEST -- 12 cycles per tick, 8,100,000 cycles per 60 Hz
// field -- at any host speed.  A host clock makes that ratio a function of the
// host, which is the gate #9 bug in both directions.  Nothing here reads host time;
// `emscripten_get_now`, `clock_gettime`, `gettimeofday` and `time(` appear nowhere
// in this facility, and verify_drive.mjs asserts the consequence by executing it.
//
// WHY IT IS NOT A SPEED CONTROL: crediting is not throttling.  The guest retires
// the same cycle count for the same work no matter how fast the host runs it, so
// this can neither speed the guest up nor slow it down -- it only makes guest time
// agree with guest work.  How much WALL time a second of guest time costs is the
// separate, outside-the-guest quantity gate #9 calls headroom.
//
// The counter lives in sr_driver.c because EVERY build links that; sr_host_os.c is
// the only thing that INTERPRETS it (sr_tb_read / sr_dec_read), so there is still
// exactly one clock.  A build WITHOUT --retire leaves it at 0 for ever, and a guest
// that then polls the timebase raises SR_F_TB_STALL by name instead of spinning on
// a plausible wrong number.
extern uint64_t g_gk_cycles;
#ifdef SR_MMIO
// THE EVENT CHECK — -DSR_MMIO (the whole-image boot) ONLY, so every fixture, golden and
// slice build keeps the one-line gk_retire below byte for byte.  A device that acts at a
// guest TIME (a VI line, the decrementer, a DMA that completes) and an interrupt that is
// waiting for MSR[EE] both need a point in the emitted code where the host may run; the
// basic-block head is that point, because it is where the retirement drive already is
// and because every guest register is in *st there (sr.py keeps no C locals across
// blocks).  It is the same granularity Dolphin's JIT checks at: CoreTiming events and
// external exceptions are serviced between blocks (Jit64 WriteExceptionExit /
// CoreTiming::Advance), never inside one.  g_gk_event_at is the earliest cycle anything
// is due; UINT64_MAX when nothing is, which makes this one compare per block.
extern uint64_t g_gk_event_at;
void gk_event(void);
static inline void gk_retire(uint32_t cycles){
    g_gk_cycles += cycles;
    if (g_gk_cycles >= g_gk_event_at) gk_event();
}
#else
static inline void gk_retire(uint32_t cycles){ g_gk_cycles += cycles; }
#endif

static inline uint32_t gk_phys(uint32_t ea) { return ea & 0x03FFFFFFu; }

static inline int gk_ok(uint32_t p, uint32_t n) {
    if (p + n > g_ram_size) { if (!g_fault) g_fault = p | 0x80000000u; return 0; }
    return 1;
}

// ------------------------------------------------- GUEST REGIONS OUTSIDE MEM1
// Two windows outside MEM1 that real SAB overlay code touches constantly.  They are
// NOT the same kind of thing, and treating them as one class ("unmodelled") is what
// made every locked-cache function unverifiable:
//
//   0xE0000000..0xE0040000  THE GEKKO LOCKED L1 CACHE -- and it is ORDINARY MEMORY.
//     DOLSDK OSCache.c:309-365 `__LCEnable()` maps it with DBAT3 (LC_BASE_PREFIX =
//     0xE000, `mtspr DBAT3L/DBAT3U`) and locks LC_LINES = 512 x 32 B with `dcbz_l`;
//     from then on the program reads and writes it with plain lwz/stw/psq_l/psq_st
//     (SAB's matrix stack lives there -- main.dol 0x80116098 pushes a 48-byte matrix
//     with six psq_l/psq_st pairs off a pointer held at 0x803ae0c4).  Dolphin models
//     it with NO cache semantics whatever: MMU.cpp:246-253 (read) and :437-442
//     (write) are a straight memcpy into `m_l1_cache`, sized 256 KB at Memmap.h:253
//     and registered at 0xE0000000 by Memmap.cpp:114.  So this runtime models it the
//     SAME way -- a real backing buffer whose loads and stores are exactly as
//     comparable as any MEM1 byte.
//
//   0xCC008000..0xCC009000  WPAR, the write-gather pipe -- the port the guest pushes
//     GX commands through.  MMIO, write-only by design: there is nothing to read
//     back and no bytes anyone can compare.  This one really is a sink.
//
// Under the plain masking above BOTH windows alias into live MEM1 -- gk_phys keeps
// only 26 bits, so 0xE0000030 -> offset 0x30 and 0xCC008000 -> offset 0x8000 -- and
// gk_ok's bound does not catch either, because an aliased offset that small is IN
// RANGE.  So an access there does not fault; it CORRUPTS MEM1 (offset 0x30 is guest
// low memory) and forges write events.  That is a defect in the SHIPPING runtime and
// not only in the differential one, which is why the mapping below is unconditional
// now.  (Do not confuse this with Dolphin's own mask: Memmap.cpp:723 uses
// 0x3FFFFFFF, under which 0xE0000030 becomes 0x20000030 -- that is the address in
// its panic message, and a different number for a different reason.)
//
// THE ORDER OF THE TEST IS THE WHOLE POINT, and getting it wrong is measured: a first
// version consulted the window map only AFTER the masked offset failed the bound,
// which covers the locked cache by accident and misses WPAR entirely.  Fixture
// 0x812188c0 then FAILED with `write event #44: want [0x2d49e3]=0 got [0x8000]=61`
// and 169 write events against 101 -- the guest pushing GX commands through WPAR,
// landing on MEM1 offset 0x8000.  A named window is decided by its EFFECTIVE address,
// before masking.
//
// Both windows live in a tail g_ram carries past MEM1 (sr_driver.c allocates it).
// `g_ram_size` still reports MEM1 only, so gk_ok's bound is unchanged.
#define GK_L1_SIZE    0x00040000u          /* 256 KB locked L1  (Memmap.h:253) */
#define GK_WPAR_LO    0xCC008000u
#define GK_WPAR_SIZE  0x00001000u          /* 4 KB around WPAR */
#define GK_L1_OFF     (g_ram_size)
#define GK_WPAR_OFF   (g_ram_size + GK_L1_SIZE)

/* ------------------------------------------------- THE HARDWARE REGISTER WINDOW
   -DSR_MMIO ONLY.  ADDITIVE AND DEFAULT-OFF: with it undefined every macro and
   every emitted access below is byte-for-byte what it was, so no fixture, no
   golden vector and no slice build changes.  It exists for the WHOLE-IMAGE BOOT
   build (build_image.sh), which is the first build here to run `__start` and
   therefore the first to touch a device register at all -- a fixture captured
   mid-scene never does.

   0xCC000000..0xCC008000 is the 32 KB of GameCube device registers: CP 0xCC000000,
   PE 0xCC001000, VI 0xCC002000, PI 0xCC003000, MI 0xCC004000, DSP+AI 0xCC005000,
   DI 0xCC006000, SI 0xCC006400, EXI 0xCC006800, AI 0xCC006C00.  WPAR at
   0xCC008000 is deliberately NOT in this range -- it keeps its own arm above,
   because it is a write-only FIFO port and this window is not.

   WHAT THIS IS AND IS NOT.  It is a BACKING BUFFER, not a device model: a read
   returns the last value written (or 0), and nothing here completes a DVD
   command or advances a VI line counter.  That is stated so nobody reads a boot
   that gets further with -DSR_MMIO as evidence that the hardware is emulated.
   Its ONE correctness claim is the same one the locked-cache arm makes: without
   a named window, gk_phys(0xCC002000) = 0x0C002000 leaves MEM1's 24 MB bound, so
   the access FAULTS -- which is at least loud.  The far worse case is a register
   in a range that masks back INTO MEM1; keeping the whole window named means no
   device access can ever silently corrupt guest memory. */
#ifdef SR_MMIO
#define GK_HWREG_LO   0xCC000000u
#define GK_HWREG_SIZE 0x00008000u          /* 32 KB of device registers */
#define GK_HWREG_OFF  (g_ram_size + GK_L1_SIZE + GK_WPAR_SIZE)
#define GK_TAIL_SIZE  (GK_L1_SIZE + GK_WPAR_SIZE + GK_HWREG_SIZE)
#else
#define GK_TAIL_SIZE  (GK_L1_SIZE + GK_WPAR_SIZE)
#endif

/* FALSIFICATION SWITCH -- build with -DSR_NO_LC_MODEL for the CONTROL ARM.  It drops
   the locked-cache arm only, so an 0xE00000xx access aliases into MEM1 exactly as it
   did before this model existed.  A fixture that passes only BECAUSE the cache is
   modelled must FAIL in that build; one that passes in both was never testing the
   model.  This is the same discipline that caught a `bctr` capture being credited
   with exercising a path that never ran (commit 19412bf6). */
#ifdef SR_NO_LC_MODEL
#define GK_L1_MODELLED 0
#else
#define GK_L1_MODELLED 1
#endif

/* The predicate is a port of MMU.cpp:247-248 / :438-439: segment 0xE, below
   0xE0000000 + GetL1CacheSize().  Everything else in segment 0xE is not the cache. */
static inline int gk_tail(uint32_t ea, uint32_t n, uint32_t *p) {
    if (GK_L1_MODELLED && (ea >> 28) == 0xEu && (ea & 0x0FFFFFFFu) + n <= GK_L1_SIZE) {
        *p = GK_L1_OFF + (ea & (GK_L1_SIZE - 1u));
        return 1;
    }
    if ((ea & ~(GK_WPAR_SIZE - 1u)) == GK_WPAR_LO) {
        *p = GK_WPAR_OFF + (ea & (GK_WPAR_SIZE - 1u));
        return 1;
    }
#ifdef SR_MMIO
    /* Tested AFTER WPAR so the WPAR arm keeps priority even if the ranges are ever
       made to overlap; tested BEFORE the mask for the reason in the long note at
       the top of this section -- a named window is decided by its EFFECTIVE
       address.  n is not bounds-checked against the window end because the guest
       cannot straddle 0xCC008000 with a single aligned access and WPAR owns the
       next page anyway. */
    if ((ea & ~(GK_HWREG_SIZE - 1u)) == GK_HWREG_LO) {
        *p = GK_HWREG_OFF + (ea & (GK_HWREG_SIZE - 1u));
        return 1;
    }
#endif
    return 0;
}
/* [2026-09-29] MEM1 FIRST, SLOW PATH OUT OF LINE.  An EA in 0x80000000..0x81FFFFFF can be none
   of the tail windows (locked cache 0xE, WPAR/HWREG 0xCC), so gk_tail() would return 0 and the
   result would be gk_phys(ea) = ea & 0x03FFFFFF = ea & 0x01FFFFFF with the same bounds check:
   the inline test is that identical mapping, done first because it is almost every access a
   game makes.  EVERYTHING else -- including a MEM1-segment EA past g_ram_size, which must still
   raise the fault -- goes to gk_map_slow(), which is the old GK_MAP body verbatim.  It is kept
   out of line because the old fully-inlined form put gk_tail's three window tests at every one
   of the ~1,400 loads/stores of SAB's largest function (fn_80150b6c), and clang -O2 on that one
   function alone was OOM-killed at 10.4 GB peak RSS (measured 2026-09-29).  0xFFFFFFFF is never
   a valid offset (MEM1 + tail < 64 MB), so it is the failure sentinel. */
__attribute__((noinline)) static uint32_t gk_map_slow(uint32_t ea, uint32_t n) {
    uint32_t p;
    if (!gk_tail(ea, n, &p)) {
        p = gk_phys(ea);
        if (!gk_ok(p, n)) return 0xFFFFFFFFu;
    }
    return p;
}
#define GK_MAP(ea, n, p, fail)  do {                                                   (p) = (ea) & 0x01FFFFFFu;                                                      if (!(((ea) >> 25) == 0x40u && (p) + (n) <= g_ram_size)) {                         (p) = gk_map_slow((ea), (n));                                                  if ((p) == 0xFFFFFFFFu) { fail; }                                          }                                                                          } while (0)
/* WPAR ONLY.  A store to the write-gather pipe is not a memory change anyone can
   compare; a store to the locked cache is, and is logged like any other. */
/* Bounded on BOTH sides rather than just the low end.  Without -DSR_MMIO the WPAR
   page is the last thing in the tail, so the upper bound is unreachable and this is
   byte-for-byte the old `(p) >= GK_WPAR_OFF`; with it, the device-register window
   sits above WPAR and must NOT be silently reclassified as the write-gather pipe. */
#define GK_IS_WPAR(p) ((p) >= GK_WPAR_OFF && (p) < GK_WPAR_OFF + GK_WPAR_SIZE)

// ------------------------------------------------- differential-verify hooks
// Compiled in ONLY under -DSR_VERIFY (the fixture harness); the shipping runtime
// gets identical code to before.  Two checks, both of which have to hold for a
// fixture replay to mean anything:
//   READ  — every guest byte read must have been STAGED from the oracle capture.
//           An unstaged read means this translation looked at memory the hardware
//           never looked at, which would otherwise silently read zero and produce
//           a plausible wrong answer.
//   WRITE — every guest byte whose value CHANGES is appended to an ordered log,
//           so the log can be diffed against Dolphin's ordered store log
//           independent of store granularity (native `stmw` is one 72-byte record;
//           this emits 18 stores — per-byte change events make them comparable).
#ifdef SR_VERIFY
extern uint8_t *g_staged;          // 1 byte per guest byte, 1 = staged
extern uint32_t g_unstaged;        // first unstaged read (| 0x80000000), 0 = none
extern uint32_t *g_wlog;           // change events, 2 words each: [phys addr][new byte]
extern uint32_t  g_wlog_n, g_wlog_cap;   // _n = events recorded, _cap = events allocated
static uint8_t   gk_wpre[64];
static inline void gk_rd_chk(uint32_t p, uint32_t n){
    if (!g_staged) return;
    for (uint32_t i = 0; i < n; i++)
        if (!g_staged[p + i]) { if (!g_unstaged) g_unstaged = (p + i) | 0x80000000u; return; }
}
static inline void gk_w_pre(uint32_t p, uint32_t n){
    if (n <= sizeof gk_wpre) for (uint32_t i = 0; i < n; i++) gk_wpre[i] = g_ram[p + i];
}
static inline void gk_w_post(uint32_t p, uint32_t n){
    // A store into WPAR is not a memory change anyone can compare: it is MMIO, the
    // oracle cannot read those bytes back either.  Do not log it -- but DO mark it
    // staged, so a later read of what this same invocation just wrote is legal while
    // a read of anything else in the window trips the unstaged-read check and fails
    // the fixture loudly instead of quietly returning zero.
    // THE LOCKED CACHE IS NOT IN THIS ARM ANY MORE: it is modelled memory, its
    // stores are logged and compared like MEM1's, and its initial contents are
    // staged by the capture (native_oracle_gdb.LockedCacheReader).
    if (GK_IS_WPAR(p)) {
        if (g_staged) for (uint32_t i = 0; i < n; i++) g_staged[p + i] = 1;
        return;
    }
    if (!g_wlog || n > sizeof gk_wpre) return;
    // Two words per event: a 24 MB MEM1 needs 25 address bits, so packing the byte
    // into the same word would overflow. Keep them separate.
    for (uint32_t i = 0; i < n; i++)
        if (gk_wpre[i] != g_ram[p + i] && g_wlog_n < g_wlog_cap) {
            g_wlog[2 * g_wlog_n] = p + i;
            g_wlog[2 * g_wlog_n + 1] = g_ram[p + i];
            g_wlog_n++;
        }
}
#define GK_RD(p, n)  gk_rd_chk((p), (n))
#define GK_WPRE(p, n)  gk_w_pre((p), (n))
#define GK_WPOST(p, n) gk_w_post((p), (n))
#ifdef SR_MMIO
#error "-DSR_VERIFY and -DSR_MMIO are mutually exclusive: SR_VERIFY owns GK_RD/GK_WPOST for \
the differential's staged-read and ordered-write instruments, and SR_MMIO needs the same two \
hooks for device semantics. A fixture replay has no device window and a boot has no capture to \
diff, so nothing needs both -- but a build that silently got one instrument instead of the other \
would produce a plausible wrong answer, which is what this stops."
#endif
#else
#ifdef SR_MMIO
/* -------------------------------------------------- DEVICE HOOKS (-DSR_MMIO only)
   The SAME two hook points the differential build uses for its staged-read and
   ordered-write instruments, reused here for the thing a BOOT needs and a fixture
   never does: a device register that is not just memory.

   WHY A HOOK AND NOT A BACKING BUFFER.  Measured 2026-09-04 on the whole-image build
   (wasm md5 0464002e...): SAB's `__OSReadROM` -> EXIImm/EXISync wedges FOREVER at
   0x800e6494, polling EXI channel 0's CR register at 0xCC00680C for TSTART (bit 0) to
   clear.  On hardware the EXI controller clears it when the transfer finishes.  Against
   a plain backing buffer it stays set, and the guest spins.  The boot cannot get past
   the SRAM read without SOMETHING clearing that bit.

   Cost, stated plainly: one compare against the device window on every guest load and
   every guest store.  That is not free, and it is why this is -DSR_MMIO-gated and why
   no measurement build should define it. */
extern void gk_dev_read (uint32_t p, uint32_t n);
extern void gk_dev_write(uint32_t p, uint32_t n);

/* ------------------------------------------------ THE WRITE-GATHER PIPE IS NOT A SINK
   [sr-gx 2026-09-04]  The store hook's lower bound moves from GK_HWREG_OFF down to
   GK_WPAR_OFF, so the WPAR page reaches a hook for the first time.

   WHY IT HAS TO.  This image translates SAB's OWN GX library out of main.dol -- GX is
   not shimmed here the way gamecube/recomp/shims/src/gx_wgpipe.c shims MP4's decomp.
   So every GX command this guest issues is a plain guest store to 0xCC008000, and
   gk_tail() (:199-202) maps that to a 4 KB scratch page that NOTHING reads.  The old
   comment at :118-121 calls WPAR "a sink"; that is true of the REGISTER (there is
   nothing to read back) and false of the STREAM, which is the entire graphics output
   of the machine.  Under the old bound those bytes were overwritten every 4 KB, so
   "the boot never reached GX" and "GX ran and its output vanished" were not
   distinguishable by any instrument this image had.

   ONE compare, not two.  Everything at or above GK_WPAR_OFF goes to gk_tail_write(),
   which does the WPAR-vs-device split itself (sr_gx.c) and forwards device writes to
   gk_dev_write() unchanged.  A MEM1 store -- the overwhelming majority -- still costs
   exactly one compare against one global, as it did before.

   The load hook is deliberately NOT moved: WPAR really is write-only, and a read there
   has no value to stage. */
extern void gk_tail_write(uint32_t p, uint32_t n);
#define GK_RD(p, n)    do { if ((p) >= GK_HWREG_OFF) gk_dev_read((p), (n)); } while (0)
#define GK_WPRE(p, n)  ((void)0)
#define GK_WPOST(p, n) do { if ((p) >= GK_WPAR_OFF) gk_tail_write((p), (n)); } while (0)
#else
#define GK_RD(p, n)    ((void)0)
#define GK_WPRE(p, n)  ((void)0)
#define GK_WPOST(p, n) ((void)0)
#endif
#endif

// ------------------------------------------------------- big-endian guest memory
// The mapped forms: every window, every hook.  Under SR_VERIFY they are the ONLY forms.
static inline uint8_t  gk_r8_m (uint32_t ea){ uint32_t p; GK_MAP(ea,1,p,return 0); GK_RD(p,1); return g_ram[p]; }
static inline uint16_t gk_r16_m(uint32_t ea){ uint32_t p; GK_MAP(ea,2,p,return 0); GK_RD(p,2);
    return (uint16_t)((g_ram[p]<<8)|g_ram[p+1]); }
static inline uint32_t gk_r32_m(uint32_t ea){ uint32_t p; GK_MAP(ea,4,p,return 0); GK_RD(p,4);
    return ((uint32_t)g_ram[p]<<24)|((uint32_t)g_ram[p+1]<<16)|((uint32_t)g_ram[p+2]<<8)|g_ram[p+3]; }
static inline void gk_w8_m (uint32_t ea,uint8_t v){ uint32_t p; GK_MAP(ea,1,p,return);
    GK_WPRE(p,1); g_ram[p]=v; GK_WPOST(p,1); }
static inline void gk_w16_m(uint32_t ea,uint16_t v){ uint32_t p; GK_MAP(ea,2,p,return); GK_WPRE(p,2);
    g_ram[p]=(uint8_t)(v>>8); g_ram[p+1]=(uint8_t)v; GK_WPOST(p,2); }
static inline void gk_w32_m(uint32_t ea,uint32_t v){ uint32_t p; GK_MAP(ea,4,p,return); GK_WPRE(p,4);
    g_ram[p]=(uint8_t)(v>>24); g_ram[p+1]=(uint8_t)(v>>16); g_ram[p+2]=(uint8_t)(v>>8); g_ram[p+3]=(uint8_t)v;
    GK_WPOST(p,4); }

#ifdef SR_VERIFY
static inline uint8_t  gk_r8 (uint32_t ea){ return gk_r8_m(ea); }
static inline uint16_t gk_r16(uint32_t ea){ return gk_r16_m(ea); }
static inline uint32_t gk_r32(uint32_t ea){ return gk_r32_m(ea); }
static inline void gk_w8 (uint32_t ea,uint8_t v){ gk_w8_m(ea,v); }
static inline void gk_w16(uint32_t ea,uint16_t v){ gk_w16_m(ea,v); }
static inline void gk_w32(uint32_t ea,uint32_t v){ gk_w32_m(ea,v); }
#else
/* [2026-09-29] MEM1 FAST PATH, AND GUEST WORDS THAT DO NOT ALIAS THE REGISTER FILE.
   WHAT IS THE SAME.  For an EA in 0x80000000..0x81FFFFFF with p + n <= g_ram_size the mapped
   form computes p = ea & 0x01FFFFFF (GK_MAP above), and its hooks are all no-ops there: GK_RD
   fires only at p >= GK_HWREG_OFF and GK_WPOST only at p >= GK_WPAR_OFF, both >= g_ram_size.
   So the fast path is that same access with the dead checks removed; every other EA -- the
   locked cache, WPAR, device registers, and an out-of-bounds MEM1 EA that must fault -- goes to
   the mapped form, out of line.
   WHAT CHANGES, AND WHY IT IS THE POINT.  The mapped form stores four uint8_t, and a char store
   may alias ANY object, so clang must assume each guest store can overwrite st->gpr[], ps0/ps1,
   g_ram and g_ram_size: read from the -S output of SAB's fn_80150b6c, every guest store
   re-loaded the g_ram pointer four times and re-loaded every guest register it touched next.
   A 32-bit guest word is accessed here as `unsigned long` (32 bits on wasm32), a type NOTHING
   in GekkoState or the runtime globals has, so type-based alias analysis may keep them in
   registers.  That is only sound if every access to GUEST MEMORY is either this type or a char
   type (chars alias everything): 8- and 16-bit accesses stay bytes, 64-bit ones are two words,
   dcbz stays bytes.  Guest memory and the host register file are disjoint host objects, so the
   no-alias fact is true, not assumed.  On an LP64 host (the native unit tests) there is no
   32-bit type other than unsigned int, so it falls back to uint32_t: same values, no gain. */
#if defined(__SIZEOF_LONG__) && __SIZEOF_LONG__ == 4
typedef unsigned long gk_gword;
#else
typedef uint32_t gk_gword;
#endif
typedef gk_gword gk_gword_u __attribute__((aligned(1)));
#define GK_FAST(ea, n)  (((ea) >> 25) == 0x40u && ((ea) & 0x01FFFFFFu) + (n) <= g_ram_size)
__attribute__((noinline)) static uint8_t  gk_r8_s (uint32_t ea){ return gk_r8_m(ea); }
__attribute__((noinline)) static uint16_t gk_r16_s(uint32_t ea){ return gk_r16_m(ea); }
__attribute__((noinline)) static uint32_t gk_r32_s(uint32_t ea){ return gk_r32_m(ea); }
__attribute__((noinline)) static void gk_w8_s (uint32_t ea,uint8_t v){ gk_w8_m(ea,v); }
__attribute__((noinline)) static void gk_w16_s(uint32_t ea,uint16_t v){ gk_w16_m(ea,v); }
__attribute__((noinline)) static void gk_w32_s(uint32_t ea,uint32_t v){ gk_w32_m(ea,v); }
static inline uint8_t  gk_r8 (uint32_t ea){
    if (GK_FAST(ea,1)) return g_ram[ea & 0x01FFFFFFu];
    return gk_r8_s(ea); }
static inline uint16_t gk_r16(uint32_t ea){
    if (GK_FAST(ea,2)) { const uint8_t *q = g_ram + (ea & 0x01FFFFFFu); return (uint16_t)((q[0]<<8)|q[1]); }
    return gk_r16_s(ea); }
static inline uint32_t gk_r32(uint32_t ea){
    if (GK_FAST(ea,4)) return __builtin_bswap32((uint32_t)*(const gk_gword_u *)(g_ram + (ea & 0x01FFFFFFu)));
    return gk_r32_s(ea); }
static inline void gk_w8 (uint32_t ea,uint8_t v){
    if (GK_FAST(ea,1)) { g_ram[ea & 0x01FFFFFFu] = v; return; }
    gk_w8_s(ea,v); }
static inline void gk_w16(uint32_t ea,uint16_t v){
    if (GK_FAST(ea,2)) { uint8_t *q = g_ram + (ea & 0x01FFFFFFu); q[0]=(uint8_t)(v>>8); q[1]=(uint8_t)v; return; }
    gk_w16_s(ea,v); }
static inline void gk_w32(uint32_t ea,uint32_t v){
    if (GK_FAST(ea,4)) { *(gk_gword_u *)(g_ram + (ea & 0x01FFFFFFu)) = (gk_gword)__builtin_bswap32(v); return; }
    gk_w32_s(ea,v); }
#endif
static inline uint64_t gk_r64(uint32_t ea){ return ((uint64_t)gk_r32(ea)<<32) | gk_r32(ea+4); }
static inline void gk_w64(uint32_t ea,uint64_t v){ gk_w32(ea,(uint32_t)(v>>32)); gk_w32(ea+4,(uint32_t)v); }

// ------------------------------------------------------------------ bit casts
static inline double   gk_bd(uint64_t b){ double d; memcpy(&d,&b,8); return d; }
static inline uint64_t gk_db(double d){ uint64_t b; memcpy(&b,&d,8); return b; }
static inline float    gk_bf(uint32_t b){ float f; memcpy(&f,&b,4); return f; }
static inline uint32_t gk_fb(float f){ uint32_t b; memcpy(&b,&f,4); return b; }

#define GK_DOUBLE_SIGN 0x8000000000000000ULL
#define GK_DOUBLE_EXP  0x7FF0000000000000ULL
#define GK_DOUBLE_FRAC 0x000FFFFFFFFFFFFFULL
#define GK_DOUBLE_FRAC_WIDTH 52

// Common/FloatUtils.h ConvertToDouble — the single->double expansion the hardware does
// on lfs/psq_l(FLOAT). For normals it is the plain widening; denormal singles get the
// exponent fixup, which the plain (double)f32 cast also produces, so a cast is exact.
static inline uint64_t gk_cvt_to_double(uint32_t w){ return gk_db((double)gk_bf(w)); }

// Interpreter_FPUtils.h:90  Force25Bit — Gekko rounds frC's mantissa to 25 bits.
static inline double gk_force25(double d){
    uint64_t integral = gk_db(d);
    uint64_t exponent = integral & GK_DOUBLE_EXP;
    uint64_t fraction = integral & GK_DOUBLE_FRAC;
    if (exponent == 0 && fraction != 0) {
        int64_t keep_mask = (int64_t)0xFFFFFFFFF8000000LL;
        uint64_t round = 0x8000000ULL;
        int lz = 0; uint64_t t = fraction;
        while (!(t & 0x8000000000000000ULL)) { t <<= 1; lz++; }
        uint32_t shift = (uint32_t)(lz - (63 - GK_DOUBLE_FRAC_WIDTH));
        keep_mask >>= shift;
        round >>= shift;
        integral = (integral & (uint64_t)keep_mask) + (integral & round);
    } else {
        integral = (integral & 0xFFFFFFFFF8000000ULL) + (integral & 0x8000000ULL);
    }
    return gk_bd(integral);
}

// Interpreter_FPUtils.h:52  ForceSingle — FPSCR.NI is 0 in every shipping game
// configuration we translate (sr.py asserts nothing sets it), so this is the plain
// round-to-nearest double->single narrowing.
static inline float gk_force_single(double v){ return (float)v; }

// Interpreter_FPUtils.h:143  NI_mul (non-NaN path; NaN payload propagation preserved).
static inline double gk_ni_mul(double a, double b){
    double r = a * b;
    if (isnan(r)) {
        if (isnan(a)) return gk_bd(gk_db(a) | 0x0008000000000000ULL);
        if (isnan(b)) return gk_bd(gk_db(b) | 0x0008000000000000ULL);
        return (double)NAN;
    }
    return r;
}
static inline double gk_ni_add(double a, double b){
    double r = a + b;
    if (isnan(r)) {
        if (isnan(a)) return gk_bd(gk_db(a) | 0x0008000000000000ULL);
        if (isnan(b)) return gk_bd(gk_db(b) | 0x0008000000000000ULL);
        return (double)NAN;
    }
    return r;
}
static inline double gk_ni_sub(double a, double b){ return gk_ni_add(a, -b); }

// [2026-09-29] EXACT FMA WITHOUT THE SOFTWARE FMA WHEN THE PRODUCT IS EXACT.  wasm has no fused
// multiply-add, so libc fma() is a soft-float routine (musl fma/normalize/mul/scalbn: 21% of the
// busy time of the City Escape run, node --cpu-prof).  fma(a,c,b) is RN(a*c + b).  When a*c is
// EXACTLY representable -- both operands normal, the two significands together need at most 53
// bits, and the product's exponent stays inside the normal range -- the plain product is that
// exact value and `a*c + b` rounds once, which IS fma(a,c,b), bit for bit (overflow and
// underflow of the final sum round identically, since both round the same exact real).  Anything
// else takes libc fma().  Single-precision operands (24 bits) times Force25Bit(c) (25 bits) is
// 49 bits: the paired-single / fmadds path is always the fast one.
static inline int gk_sigbits(uint64_t u) {       // significant bits of a normal double's significand
    uint64_t m = (u & 0x000FFFFFFFFFFFFFULL) | 0x0010000000000000ULL;
    return 53 - __builtin_ctzll(m);
}
extern int g_gk_fma_fast;                        // run-time arm (sr_driver.c): 0 = always libc fma
static inline double gk_fma(double a, double c, double b) {
    if (!g_gk_fma_fast) return fma(a, c, b);
    const uint64_t ua = gk_db(a), uc = gk_db(c);
    const int ea = (int)((ua >> 52) & 0x7FF), ec = (int)((uc >> 52) & 0x7FF);
    if (ea != 0 && ea != 0x7FF && ec != 0 && ec != 0x7FF) {
        const int e = (ea - 1023) + (ec - 1023);
        if (e > -1000 && e < 1000 && gk_sigbits(ua) + gk_sigbits(uc) <= 53) {
            // a*c is exact here, so whether or not the compiler contracts this into a fused
            // operation the result is RN(a*c + b) either way (wasm has no fused op at all)
            return a * c + b;
        }
    }
    return fma(a, c, b);
}

// Interpreter_FPUtils.h:285  NI_madd_msub<sub, single=true> — a*c+b with frC forced to a
// 25-bit mantissa, computed as one 64-bit FMA, plus the 2Sum tie-break correction that
// makes the later narrowing to single round exactly once (the Mario-Strikers case).
static inline double gk_ni_madd_single(double a, double c, double b, int sub){
    const double c_round = gk_force25(c);
    const double b_sign  = sub ? -b : b;
    double value = gk_fma(a, c_round, b_sign);
    const uint64_t rb = gk_db(value);
    const uint64_t D_MASK  = 0x000000001FFFFFFFULL;
    const uint64_t EVEN_TIE= 0x0000000010000000ULL;
    if ((rb & D_MASK) == EVEN_TIE) {
        const double a_prime = b_sign - value;
        const double b_prime = value + a_prime;
        const double delta_a = gk_fma(a, c_round, a_prime);
        const double delta_b = b_sign - b_prime;
        const double error   = delta_a + delta_b;
        if (error != 0.0) {
            if ((error > 0.0) == (value > 0.0)) value = gk_bd(rb + 1);
            else                                value = gk_bd(rb - 1);
        }
    }
    if (isnan(value)) {
        if (isnan(a)) return gk_bd(gk_db(a) | 0x0008000000000000ULL);
        if (isnan(b)) return gk_bd(gk_db(b) | 0x0008000000000000ULL);
        if (isnan(c)) return gk_bd(gk_db(c) | 0x0008000000000000ULL);
        return (double)NAN;
    }
    return value;
}
// double-precision FMA form (fmadd/fmsub): plain std::fma, no frC rounding, no tie fix.
static inline double gk_ni_madd_double(double a, double c, double b, int sub){
    double v = gk_fma(a, c, sub ? -b : b);
    if (isnan(v)) {
        if (isnan(a)) return gk_bd(gk_db(a) | 0x0008000000000000ULL);
        if (isnan(b)) return gk_bd(gk_db(b) | 0x0008000000000000ULL);
        if (isnan(c)) return gk_bd(gk_db(c) | 0x0008000000000000ULL);
        return (double)NAN;
    }
    return v;
}

// nmadd / nmsub / ps_nmadd / ps_nmsub negate the ROUNDED result, and DO NOT negate a
// NaN — Interpreter_Paired.cpp:314,338 and Interpreter_FloatingPoint.cpp:677,723
// (`std::isnan(tmp) ? tmp : -tmp`). Negating before rounding, or negating the NaN, flips
// the QNaN sign: caught by the PSMTXInverse differential (want 7fc00000, got ffc00000).
static inline float  gk_negns_f(float v){ return (v != v) ? v : -v; }
static inline double gk_negns_d(double v){ return (v != v) ? v : -v; }

// SetBoth(float, float) — Interpreter stores both slots widened back to binary64.
static inline void gk_set_both(GekkoState *st, int d, float p0, float p1){
    st->ps0[d] = gk_db((double)p0);
    st->ps1[d] = gk_db((double)p1);
}

// ------------------------------------------------------ paired quantized ld/st
// Interpreter_LoadStorePaired.cpp:218 Helper_Dequantize / :144 Helper_Quantize, ALL types.
// [2026-09-29] Was float-mode only (a non-float GQR faulted 0xDEAD0001/2); SAB's game code sets
// integer GQRs (mtspr 912-919), so the integer types are transcribed: the u8/u16/s8/s16 value is
// converted to float, multiplied by the float scale table entry (single precision, as Dolphin's
// `float(T(v)) * m_dequantizeTable[ld_scale]`), then widened; stores scale in float, clamp to the
// type's range in float, and truncate (ScaleAndClamp).  Types 1-3 are invalid on hardware
// (Dolphin asserts and loads 0); they still fault here.  GQR: st_type 0-2, st_scale 8-13,
// ld_type 16-18, ld_scale 24-29 (UGQR).
static inline float gk_qscale(uint32_t s, int dequant) {
    // m_dequantizeTable[s] = 2^-s for s < 32, 2^(64-s) for s >= 32; m_quantizeTable the inverse
    int e = s < 32 ? (int)s : (int)s - 64;
    if (dequant) e = -e;
    float f = 1.0f;
    if (e > 0) while (e--) f *= 2.0f; else while (e++ < 0) f *= 0.5f;
    return f;
}
static inline double gk_deq(uint32_t t, uint32_t v, float sc) {
    float f;
    switch (t) {
    case 4: f = (float)(uint8_t)v;  break;
    case 5: f = (float)(uint16_t)v; break;
    case 6: f = (float)(int8_t)v;   break;
    default: f = (float)(int16_t)v; break;       // 7
    }
    return (double)(f * sc);
}
static inline void gk_psq_l(GekkoState *st, int d, uint32_t ea, int w, int i){
    const uint32_t gqr = st->gqr[i];
    const uint32_t ld_type = (gqr >> 16) & 7;
    if (ld_type == 0) {
        if (w) {
            st->ps0[d] = gk_cvt_to_double(gk_r32(ea));
            st->ps1[d] = gk_db(1.0);
        } else {
            uint64_t pair = gk_r64(ea);
            st->ps0[d] = gk_cvt_to_double((uint32_t)(pair >> 32));
            st->ps1[d] = gk_cvt_to_double((uint32_t)pair);
        }
        return;
    }
    if (ld_type < 4) { g_fault = 0xDEAD0001u; return; }   // invalid type: Dolphin asserts
    const float sc = gk_qscale((gqr >> 24) & 0x3F, 1);
    const int wide = (ld_type == 5 || ld_type == 7);
    if (w) {
        uint32_t v = wide ? gk_r16(ea) : gk_r8(ea);
        st->ps0[d] = gk_db(gk_deq(ld_type, v, sc));
        st->ps1[d] = gk_db(1.0);
    } else if (wide) {
        uint32_t v = gk_r32(ea);
        st->ps0[d] = gk_db(gk_deq(ld_type, v >> 16, sc));
        st->ps1[d] = gk_db(gk_deq(ld_type, v & 0xFFFF, sc));
    } else {
        uint32_t v = gk_r16(ea);
        st->ps0[d] = gk_db(gk_deq(ld_type, v >> 8, sc));
        st->ps1[d] = gk_db(gk_deq(ld_type, v & 0xFF, sc));
    }
}

// Common/FloatUtils.h ConvertToSingleFTZ: double -> single bit pattern, flushing
// out-of-single-range exponents to zero rather than to denormal/infinity.
static inline uint32_t gk_cvt_to_single_ftz(uint64_t x){
    const uint32_t exp = (uint32_t)((x >> 52) & 0x7FF);
    if (exp > 896 || (x & ~GK_DOUBLE_SIGN) == 0)
        return (uint32_t)(((x >> 32) & 0xC0000000u) | ((x >> 29) & 0x3FFFFFFFu));
    return (uint32_t)((x >> 32) & 0x80000000u);
}

static inline uint32_t gk_qclamp(uint32_t t, uint64_t psbits, float sc) {
    double ps; memcpy(&ps, &psbits, 8);
    float v = (float)ps * sc, lo, hi;
    switch (t) {
    case 4: lo = 0.0f; hi = 255.0f; break;
    case 5: lo = 0.0f; hi = 65535.0f; break;
    case 6: lo = -128.0f; hi = 127.0f; break;
    default: lo = -32768.0f; hi = 32767.0f; break;
    }
    v = v < lo ? lo : v > hi ? hi : v;            // std::clamp (NaN passes through: not modelled)
    return (t == 4 || t == 5) ? (uint32_t)v : (uint32_t)(int32_t)v;
}
static inline void gk_psq_st(GekkoState *st, int s, uint32_t ea, int w, int i){
    const uint32_t gqr = st->gqr[i];
    const uint32_t st_type = (gqr >> 0) & 7;
    if (st_type == 0) {
        const uint32_t c0 = gk_cvt_to_single_ftz(st->ps0[s]);
        if (w) { gk_w32(ea, c0); }
        else   { gk_w32(ea, c0); gk_w32(ea + 4, gk_cvt_to_single_ftz(st->ps1[s])); }
        return;
    }
    if (st_type < 4) { g_fault = 0xDEAD0002u; return; }
    const float sc = gk_qscale((gqr >> 8) & 0x3F, 0);
    const uint32_t a = gk_qclamp(st_type, st->ps0[s], sc);
    const int wide = (st_type == 5 || st_type == 7);
    if (w) { if (wide) gk_w16(ea, (uint16_t)a); else gk_w8(ea, (uint8_t)a); }
    else {
        const uint32_t b = gk_qclamp(st_type, st->ps1[s], sc);
        if (wide) gk_w32(ea, ((a & 0xFFFFu) << 16) | (b & 0xFFFFu));
        else gk_w16(ea, (uint16_t)(((a & 0xFFu) << 8) | (b & 0xFFu)));
    }
}

// ------------------------------- fres / frsqrte (Gekko's table approximations)
// Common/FloatUtils.cpp:75 frsqrte_expected / :141 fres_expected, :86 / :152 algorithms.
typedef struct { int32_t base, dec; } GkBaseDec;
static const GkBaseDec gk_frsqrte_tab[32] = {
  {0x1a7e800,-0x568},{0x17cb800,-0x4f3},{0x1552800,-0x48d},{0x130c000,-0x435},
  {0x10f2000,-0x3e7},{0x0eff000,-0x3a2},{0x0d2e000,-0x365},{0x0b7c000,-0x32e},
  {0x09e5000,-0x2fc},{0x0867000,-0x2d0},{0x06ff000,-0x2a8},{0x05ab800,-0x283},
  {0x046a000,-0x261},{0x0339800,-0x243},{0x0218800,-0x226},{0x0105800,-0x20b},
  {0x3ffa000,-0x7a4},{0x3c29000,-0x700},{0x38aa000,-0x670},{0x3572000,-0x5f2},
  {0x3279000,-0x584},{0x2fb7000,-0x524},{0x2d26000,-0x4cc},{0x2ac0000,-0x47e},
  {0x2881000,-0x43a},{0x2665000,-0x3fa},{0x2468000,-0x3c2},{0x2287000,-0x38e},
  {0x20c1000,-0x35e},{0x1f12000,-0x332},{0x1d79000,-0x30a},{0x1bf4000,-0x2e6},
};
static const GkBaseDec gk_fres_tab[32] = {
  {0x7ff800,0x3e1},{0x783800,0x3a7},{0x70ea00,0x371},{0x6a0800,0x340},{0x638800,0x313},
  {0x5d6200,0x2ea},{0x579000,0x2c4},{0x520800,0x2a0},{0x4cc800,0x27f},{0x47ca00,0x261},
  {0x430800,0x245},{0x3e8000,0x22a},{0x3a2c00,0x212},{0x360800,0x1fb},{0x321400,0x1e5},
  {0x2e4a00,0x1d1},{0x2aa800,0x1be},{0x272c00,0x1ac},{0x23d600,0x19b},{0x209e00,0x18b},
  {0x1d8800,0x17c},{0x1a9000,0x16e},{0x17ae00,0x15b},{0x14f800,0x15b},{0x124400,0x143},
  {0x0fbe00,0x143},{0x0d3800,0x12d},{0x0ade00,0x12d},{0x088400,0x11a},{0x065000,0x11a},
  {0x041c00,0x108},{0x020c00,0x106},
};

static inline double gk_frsqrte(double val){
    int64_t integral = (int64_t)gk_db(val);
    int64_t mantissa = integral & ((1LL << 52) - 1);
    const int64_t sign = integral & (int64_t)(1ULL << 63);
    int64_t exponent = integral & (0x7FFLL << 52);
    if (mantissa == 0 && exponent == 0) return sign ? -INFINITY : INFINITY;
    if (exponent == (0x7FFLL << 52)) {
        if (mantissa == 0) return sign ? (double)NAN : 0.0;
        return gk_bd(gk_db(val) | 0x0008000000000000ULL);
    }
    if (sign) return (double)NAN;
    if (!exponent) {
        do { exponent -= 1LL << 52; mantissa <<= 1; } while (!(mantissa & (1LL << 52)));
        mantissa &= (1LL << 52) - 1;
        exponent += 1LL << 52;
    }
    const int64_t exponent_lsb = exponent & (1LL << 52);
    exponent = ((0x3FFLL << 52) - ((exponent - (0x3FELL << 52)) / 2)) & (0x7FFLL << 52);
    integral = sign | exponent;
    const int i = (int)((exponent_lsb | mantissa) >> 37);
    const GkBaseDec e = gk_frsqrte_tab[i / 2048];
    integral |= (int64_t)(e.base + e.dec * (i % 2048)) << 26;
    return gk_bd((uint64_t)integral);
}

static inline double gk_fres(double val){
    int64_t integral = (int64_t)gk_db(val);
    const int64_t mantissa = integral & ((1LL << 52) - 1);
    const int64_t sign = integral & (int64_t)(1ULL << 63);
    int64_t exponent = integral & (0x7FFLL << 52);
    if (mantissa == 0 && exponent == 0) return copysign(INFINITY, val);
    if (exponent == (0x7FFLL << 52)) {
        if (mantissa == 0) return copysign(0.0, val);
        return gk_bd(gk_db(val) | 0x0008000000000000ULL);
    }
    if (exponent < (895LL << 52)) return copysign(3.4028234663852886e38, val);
    if (exponent >= (1149LL << 52)) return copysign(0.0, val);
    exponent = (0x7FDLL << 52) - exponent;
    const int i = (int)(mantissa >> 37);
    const GkBaseDec e = gk_fres_tab[i / 1024];
    integral = sign | exponent;
    integral |= (int64_t)(e.base - (e.dec * (i % 1024) + 1) / 2) << 29;
    return gk_bd((uint64_t)integral);
}

// dcbz: zeroes the 32-byte cache block containing EA (Gekko line size = 32).
// Goes through GK_MAP like every other store: `dcbz`/`dcbz_l` on a locked-cache
// address is exactly how OSCache.c:349-352 establishes the lock in the first place,
// so masking it into MEM1 would zero 32 bytes of guest low memory.
static inline void gk_dcbz(uint32_t ea){
    uint32_t p; GK_MAP(ea & ~31u, 32, p, return);
    GK_WPRE(p, 32);
    for (int i = 0; i < 32; i++) g_ram[p + i] = 0;
    GK_WPOST(p, 32);
}

// ---------------------------------------------------------------------- `sc`
// THE GUEST'S SYSTEM CALL, and it is not a call into anything this runtime owns.
// `sc` takes a Gekko SYSTEM CALL exception to 0x80000C00 and runs whatever the guest
// OS installed there.  DOLSDK installs exactly one thing, and it is seven
// instructions long -- ~/gc_refs/dolsdk2001/src/os/OSSync.c:9-21, copied to
// OSPhysicalToCached(0xC00) by __OSInitSystemCall (:23-30, SAB 0x800eb8dc):
//
//     mfspr r9, HID0        <- CLOBBERS r9
//     ori   r10, r9, 0x8    <- CLOBBERS r10   (HID0[ABE], address broadcast)
//     mtspr HID0, r10
//     isync
//     sync
//     mtspr HID0, r9        <- restores HID0; net change zero
//     rfi
//
// So the ENTIRE purpose of `sc` on this platform is to pulse address-broadcast
// around a `sync`, which is why OSCache.c puts one at the end of DCFlushRange
// (:123) and DCStoreRange (:143) and nowhere else: it publishes the writebacks the
// preceding dcbf/dcbst loop just issued to the OTHER bus masters.  This runtime has
// one flat coherent buffer and one bus master, so the pulse and the barrier are both
// no-ops -- but the handler does NOT save r9 and r10, so their clobber survives the
// rfi and is visible to the caller.  verify_fixture.mjs scores all 32 GPRs
// (:521-522), so dropping that clobber would be a scored miss, not a free
// simplification.  Both are volatile under the PowerPC ABI, so no compiler-generated
// caller depends on them -- this is exactness against the oracle, not a fix.
//
// WHAT IS NOT MODELLED, stated rather than implied:
//  * SRR0/SRR1.  The exception writes them and the rfi consumes them; GekkoState has
//    no field for either (there is no exception delivery in this runtime at all), so
//    they are absent, not wrong.  Nothing in the image reads them outside the
//    context-switch primitives, which are host-bound.
//  * The 0xC00 BYTES ARE NOT CHECKED.  gk_sc reproduces DOLSDK's vector because that
//    is what SAB installs; it does not read 0x80000C00 and confirm it, because in a
//    FIXTURE build low memory is staged only where the capture recorded it and the
//    check would fault on a correct run.  A title that installed a different vector
//    would be modelled wrong here and silently -- the containment is `--cache-audit`,
//    which enumerates all three `sc` sites and shows they are the SDK's own.
//  * r9/r10 ARE MODELLED BUT NOT YET WITNESSED.  No committed fixture executes an
//    `sc`: every function containing one was BLOCKED by the translator until this
//    boundary, so the capture record has nothing to compare against.  Said plainly
//    so the next capture through DCFlushRange is read as the first evidence, not as
//    a regression.
static inline void gk_sc(GekkoState *st){
    st->gpr[9]  = g_hid0;
    st->gpr[10] = g_hid0 | GK_HID0_ABE;
    /* mtspr HID0,r10 ; isync ; sync ; mtspr HID0,r9  -> HID0 net unchanged, and both
       barriers are no-ops on one flat coherent buffer with one bus master. */
}

// ------------------------------------------------------------- CR / XER helpers
static inline void gk_set_cr(GekkoState *st, int f, uint32_t v){
    const int sh = (7 - f) * 4;
    st->cr = (st->cr & ~(0xFu << sh)) | ((v & 0xFu) << sh);
}
static inline void gk_cmp_signed(GekkoState *st, int f, int32_t a, int32_t b){
    uint32_t v = (a < b) ? 8u : (a > b) ? 4u : 2u;
    v |= (st->xer >> 31) & 1u;   // SO
    gk_set_cr(st, f, v);
}
static inline void gk_cmp_unsigned(GekkoState *st, int f, uint32_t a, uint32_t b){
    uint32_t v = (a < b) ? 8u : (a > b) ? 4u : 2u;
    v |= (st->xer >> 31) & 1u;
    gk_set_cr(st, f, v);
}
static inline void gk_rc(GekkoState *st, uint32_t r){
    gk_cmp_signed(st, 0, (int32_t)r, 0);
}
static inline int gk_cr_bit(GekkoState *st, int b){ return (st->cr >> (31 - b)) & 1; }

static inline uint32_t gk_rotl32(uint32_t x, int n){ n &= 31; return n ? ((x << n) | (x >> (32 - n))) : x; }
static inline uint32_t gk_mask(int mb, int me){
    uint32_t m = 0xFFFFFFFFu >> mb;
    m ^= (me >= 31) ? 0u : (0xFFFFFFFFu >> (me + 1));
    return (me < mb) ? ~m : m;
}

#endif // GEKKO_RT_H
