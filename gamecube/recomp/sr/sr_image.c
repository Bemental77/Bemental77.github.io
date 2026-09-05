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
// BUFFER (gekko_rt.h) with TWO modelled devices: EXI CR's TSTART bit, which self-clears,
// and the DSP interface (reset, the ARAM DMA and the mailbox) — see THE DEVICE BOUNDARY
// below, and note that each ships with its own run-time falsifying control arm.  Every
// other register in the window is memory: a read returns the last value written.  Nothing
// here completes a DVD transfer, advances a VI line counter, or delivers ANY interrupt —
// and the last of those matters more than it looks, because the guest's own device drivers
// wait on interrupt-cleared software flags as often as they poll a register.  Any boot
// that gets further because this window exists got further because it stopped FAULTING on
// a store, not because a device answered.
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

// Gekko timebase.  40.5 MHz = GK_CPU_HZ / GK_TIMER_RATIO = 486 MHz / 12, and 675,000
// ticks is exactly one 60 Hz field — the constants CLAUDE.md gate #9 names.  THE
// IMPLEMENTATION LIVES IN sr_host_os.c (see sr_host_os.h, "THE GUEST TIMEBASE"), which
// this file already links; this is a delegation so the image has ONE clock instead of
// two that can disagree, and the GK_TB_HZ collision noted below is resolved by not
// having a second definition of the clock at all.
//
// ⚠ THIS USED TO READ emscripten_get_now(), AND THAT WAS A GATE #9 BUG — recorded here
// rather than silently deleted, because the reasoning that produced it is plausible.
// Host wall time is NOT "1:1 with the guest".  This runtime does not deliver guest work
// at hardware rate (the honest JIT figure is 0.3781x delivered on SAB cold-boot
// attract, README §8.6b), so a wall-clock TB hands the guest ~1.00 s of TIME for every
// ~0.38 s of WORK it actually retired.  The guest's own time:work ratio — a CONSTANT of
// the hardware — becomes a function of the host: guest deadlines fire early, measured
// intervals read long, and two replays of the same computation disagree, so no
// differential can be bit-exact.  In the other direction, a host FASTER than hardware
// (the entire point of the 120 headroom target) makes guest time run SLOW against guest
// work.  Both directions break "ran precisely as the hardware intended".
//
// Deriving TB from RETIRED GUEST WORK makes the ratio exactly hardware's at ANY host
// speed, and leaves "how much wall time one second of guest time costs" as a quantity
// measured OUTSIDE the guest — gate #9's second, independent knob.  It is also what the
// reference does: Dolphin's GetFakeTimeBase (SystemTimers.cpp:213-218) divides
// CoreTiming::GetTicks(), the EMULATED CPU CYCLE COUNTER, by TIMER_RATIO=12.  The only
// wall-clock input Dolphin has is the ORIGIN, taken once at boot from the RTC
// (SystemTimers.cpp:269) — sr_tb_seed() is the equivalent here.
//
// THE DRIVER IS ATTACHED, and it is not in this file.  It is `gk_retire()` inside the
// EMITTED GUEST BODIES: build_image.sh passes sr.py --retire, which opens every basic
// block with the summed Gekko cycle cost of its instructions (Dolphin's own num_cycles
// table), so guest time advances because the GUEST RAN — from instruction one, with no
// host event and no host clock anywhere in the path.  That is where Dolphin drives its
// clock from too (Jit64/Jit.cpp:1003 accumulates the same field per instruction).
//
// A RETRACE DRIVER IS STILL THE RIGHT SHAPE FOR THE FRAME BOUNDARY and is kept
// available as sr_tb_retrace() (+675,000 ticks), the same guest event the shipping MP4
// recomp drives OSGetTime from at 0.999x.  It is not attached here for two measured
// reasons: SAB's VIWaitForRetrace is not named in dolphin_captures/sab.map at all, so
// its address has to be recovered by signature first; and the translated DOLSDK body
// (~/gc_refs/dolsdk2001/src/vi/vi.c) sleeps on retraceQueue until a VI INTERRUPT bumps
// retraceCount, which this runtime cannot deliver.  Until both are solved a retrace
// hook would be inert, while the retirement drive is live now.
//
// ⚠ sr_tb_retrace() MUST be reached from the guest's retrace boundary if it is ever
// wired up — never from JS on a timer.  build_image.sh does not export _sr_tb_field or
// _sr_tb_credit for exactly that reason, and sr_host_os.c drops EMSCRIPTEN_KEEPALIVE
// from both so the omission is enforced by the linker rather than by intent.

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

// THE SECOND MODELLED DEVICE — THE DSP INTERFACE, and it is the same KIND of model.
//
// With EXI modelled the boot walks straight through __OSReadROM and __OSThreadInit and
// stops in `__OSInitAudioSystem` (0x800e4b74), which is the LAST device call OSInit makes
// (~/gc_refs/dolsdk2001/src/os/OS.c:143 — everything after it is OSReport and
// OSEnableInterrupts).  MEASURED on the closure build of that one function, wasm md5
// cb6f5ea6a664a337133dd681b2d5a106: 3 registers first-touched (0xCC005012 write,
// 0xCC00500A write, 0xCC00500A read) and then 1,000,001 device READS without returning.
// The guest is spinning on ONE register.
//
// WHICH ONE, from the SHIPPED WORDS (`python3 tools/disasm_fn.py --iso <sab.iso>
// --pc 0x800e4b74 --size 0x1bc`), NOT from sab.map and NOT from the SDK source:
//
//   800e4bc8  addi   r31, r3, 10          ; r31 = 0xCC00500A  = DSP_CONTROL
//   800e4bd4  lhz    r0, 10(r3)
//   800e4bd8  ori    r0, r0, 0x1          ; DSPReset
//   800e4bdc  sth    r0, 10(r3)
//   800e4be0  lhz    r0, 0(r31)
//   800e4be4  rlwinm r0, r0, 0, 31, 31    ; bit 0x1
//   800e4be8  bne    0x800e4be0           ; ...forever
//
// Dolphin's own header states the hardware contract in one line — DSP.h:49,
// `u16 DSPReset : 1;  // Write 1 to reset and waits for 0` — and DSPHLE.cpp:206-210 is
// the device doing it: `if (temp.DSPReset) { SetUCode(UCODE_ROM); temp.DSPReset = 0; }`.
// So this is EXACTLY the EXI TSTART shape: a bit the CPU sets and the DEVICE clears,
// modelled with zero latency.  It is a statement about timing; it invents no bytes.
//
// ONE SPIN IS NOT THE WHOLE FUNCTION.  Clearing DSPReset only moves the wedge to the next
// poll, so the model has to be the whole init handshake or it is not a model at all.
// The shipped words, in order, and what each needs (DOLSDK's OSAudioSystem.c:21-81 reads
// as the same sequence; the retail build has the three ASSERTMSGLINEs compiled out, and
// so has NO check of the mailbox VALUE — only of its valid bit):
//
//   1. 800e4bd4-800e4be8  set DSPReset, spin until the device clears it.
//   2. 800e4bf8-800e4c10  spin while DSP_MAIL_FROM_DSP has bit 0x80000000 — i.e. wait for
//                         the mailbox to be EMPTY.  A reset emptied it, so this exits at
//                         once; it is also why the ucode's mail must NOT be queued at
//                         reset time, only at the DSPInit edge below.
//   3. 800e4c14-800e4c50  AR_DMA_MMADDR/ARADDR/CNT, then spin until DSP_CONTROL bit 0x20
//                         (the ARAM-DMA-complete status), then write it back to ACK.
//                         Dolphin: Do_ARAM_DMA (DSP.cpp:457-...) sets DMAState and
//                         schedules CompleteARAM (DSP.cpp:99-104), which clears DMAState
//                         and GenerateDSPInterrupt(INT_ARAM) — DSP.cpp:392-396 ORs the
//                         status bit in regardless of the mask.  Zero latency = both, now.
//   4. 800e4c54-800e4c68  OSGetTick delay of 0x892 ticks.  Needs nothing new: the clock is
//                         already driven by RETIRED GUEST WORK (sr_host_os.c).
//   5. 800e4c6c-800e4c98  a second identical ARAM DMA + ack.
//   6. 800e4c9c-800e4cb0  clear DSPInit (0x800), then spin while DSPInitCode (0x400) is
//                         set.  DSPHLE.cpp:214-227: the 1->0 edge on DSPInit is what makes
//                         the DSP load the 128-byte ucode from 0x81000000 and run it, and
//                         it sets DSPInitCode, "which gets unset a bit later".  A
//                         zero-latency DSP has already unset it.
//   7. 800e4cb4-800e4cbc  clear DSPHalt (0x4) — the DSP now runs.
//   8. 800e4cc0-800e4cd4  spin until DSP_MAIL_FROM_DSP_HI has bit 0x8000: the ucode's
//                         reply.  Dolphin's HLE of this exact ucode is one line —
//                         INIT.cpp:20-23 `m_mail_handler.PushMail(0x80544348)`.
//   9. 800e4cd8-800e4d04  re-halt, re-init, reset, spin on DSPReset again.
//
// WHY 0x80544348 IS NOT A FABRICATED VALUE.  It is what the 128-byte ucode the guest
// ITSELF just uploaded computes: its last two instructions are `16 FC 00 54` / `16 FD 43
// 48` (OSAudioSystem.c:14, DSPInitCode[]) — store-immediate 0x0054 to DMBH and 0x4348 to
// DMBL — plus the hardware's mail-valid bit 0x80000000.  Two independent sources agree on
// it: the SDK's own debug check (OSAudioSystem.c:72, `(mail + 0x7FAC0000) != 0x4348` =>
// mail == 0x80544348) and Dolphin's HLE constant.  This runtime does not interpret DSP
// code, so the DSP is HLE'd here exactly as Dolphin HLE's it — and that is stated as the
// model's boundary, not hidden: see WHAT IS *NOT* MODELLED at the end of this block.
//
// AR_INFO (0xCC005012), the register the boot writes 0x43 to first, needs nothing: Dolphin
// masks it to 0x7f (DSP.cpp:167) and stores it as a plain variable (DSP.cpp:186), and the
// only use is `(m_aram_info.Hex & 0xf)` selecting between three ARAM memory maps whose GC
// bodies are IDENTICAL (DSP.cpp:485-500).  It is already a backing buffer and it is right.
//
// WHAT IS *NOT* MODELLED, stated rather than discovered later:
//   * NO DSP CORE.  The uploaded ucode is never executed.  The init ucode's ONLY externally
//     visible effect is the mail above, so this boot cannot tell — but the AX/Zelda ucodes
//     the game uploads later have a whole command protocol, and none of it exists here.
//   * NO AUDIO.  Nothing reaches AI (0xCC006C00) or produces a sample.
//   * NO INTERRUPT.  DSP_CONTROL's three status bits are set, but the PI line they would
//     drive (DSP.cpp:374-381) is not, because this runtime delivers no interrupts at all.
//     __OSInitAudioSystem happens to write 0x8AC, which leaves all three interrupt MASKS
//     clear, so this whole handshake is interrupt-free by the GUEST's own choice — that is
//     an accident of this function, not a general property.
//   * THE ARAM DMA MOVES REAL BYTES but ARAM itself is a plain calloc'd 16 MB buffer with
//     no refresh, no wrap behaviour beyond the 64 MB mirror mask, and no HSP path.
#define DSP_MAIL_FROM_HI 0xCC005004u
#define DSP_MAIL_FROM_LO 0xCC005006u
#define DSP_CONTROL_EA   0xCC00500Au
#define AR_DMA_MMADDR_EA 0xCC005020u
#define AR_DMA_ARADDR_EA 0xCC005024u
#define AR_DMA_CNT_EA    0xCC005028u
#define AR_DMA_CNT_LO_EA 0xCC00502Au
// DSP.h:42-68.  The three status bits the CPU can only ACKNOWLEDGE are grouped, because
// the write path treats them as one class (write-1-to-clear) and nothing else does.
#define DSPC_RESET      0x0001u
#define DSPC_HALT       0x0004u
#define DSPC_AID        0x0008u
#define DSPC_ARAM       0x0020u
#define DSPC_DSP        0x0080u
#define DSPC_DMASTATE   0x0200u
#define DSPC_INITCODE   0x0400u
#define DSPC_INIT       0x0800u
#define DSPC_INT_BITS   (DSPC_AID | DSPC_ARAM | DSPC_DSP)
#define DSP_INIT_MAIL   0x80544348u   // INIT.cpp:22 == OSAudioSystem.c:72's expected value
#define DSP_ROM_MAIL    0x8071FEEDu   // ROM.cpp ROMUCode::Initialize — the BOOT ROM's mail
#define ARAM_SIZE       0x01000000u   // DSP.h:37 ARAM_SIZE — and 0x800000D0 stages the
#define ARAM_MASK       0x00FFFFFFu   // same 16 MB into low memory (sr_image_worker.js)

static uint8_t  g_dev_seen_rd[GK_HWREG_SIZE];
static uint8_t  g_dev_seen_wr[GK_HWREG_SIZE];
static uint32_t g_dev_rd_n = 0, g_dev_wr_n = 0;   // total accesses, not distinct
static uint32_t g_exi_model = 1;
static uint32_t g_exi_clears = 0;
static uint32_t g_watchdog = 0;                   // 0 = off

// The DSP model's whole state.  g_dsp_ctrl is the DEVICE's copy of DSP_CONTROL: the
// backing buffer cannot be it, because three of its bits are write-1-to-clear and a plain
// store would overwrite them with whatever the guest wrote.
//
// THE POWER-ON VALUES ARE THE REFERENCE'S, and they are split across two objects there.
// DSP_CONTROL reads as `(manager.Hex & ~0x0C07) | (emulator.Read() & 0x0C07)`
// (DSP.cpp:252-255), so the emulator owns Reset/Assert/Halt/InitCode/Init: DSP.cpp:144-145
// gives the manager half `Hex = 0; DSPHalt = 1`, and DSPHLE.cpp:31-33 gives the emulator
// half `Hex = 0; DSPHalt = 1; DSPInit = 1`.  Composed = 0x0804.  DOLSDK agrees from the
// other side — its (retail-compiled-out) entry assert for this very function is
// `__DSPRegs[5] & 0x004` "DSP already working" (OSAudioSystem.c:32).
// The mailbox is likewise NOT empty at power-on: DSPHLE.cpp:29 runs `SetUCode(UCODE_ROM)`
// and ROM.cpp's ROMUCode::Initialize pushes 0x8071FEED.  It is invisible on this boot
// because the DSP is HALTED throughout the guest's "wait for the mailbox to be empty"
// loop and a halted mail handler shows nothing (MailHandler.cpp:37-43) — but seeding it
// is what makes that the REASON the loop exits, rather than the loop being vacuous.
static uint32_t g_dsp_model = 1;
static uint32_t g_dsp_ctrl  = DSPC_HALT | DSPC_INIT;      // 0x0804
static uint32_t g_dsp_mail  = 0;    // the DSP's last mail, latched on read (MailHandler.cpp)
// ONE queued mail is enough and that is a property of the reference, not a shortcut:
// DSPHLE::SetUCode (DSPHLE.cpp:72-77) calls ClearPending() and THEN the new ucode's
// Initialize(), so a ucode change REPLACES the queue rather than appending to it, and
// both ucodes this model knows push exactly one mail.
static uint32_t g_dsp_mail_q = DSP_ROM_MAIL;
static uint32_t g_dsp_mail_pending = 1;
static uint32_t g_dsp_events = 0;   // modelled DSP actions taken — the ON-arm's witness
static uint32_t g_aram_bytes = 0;   // bytes actually moved by a modelled ARAM DMA
static uint8_t *g_aram = 0;         // allocated on the first DMA, never before

#define DEV_LOG_CAP 512
// [guest addr][kind]: 1=read 2=write 3=EXI-model, and 4..6 the three DSP-model actions.
// sr_image_worker.js's DEVKIND table is the other half of this and must move with it.
#define DEVK_DSP_RESET 4
#define DEVK_DSP_ARAM  5
#define DEVK_DSP_MAIL  6
static uint32_t g_dev_log[DEV_LOG_CAP * 2];
static uint32_t g_dev_log_n = 0;

static void dev_log(uint32_t ea, uint32_t kind) {
    if (g_dev_log_n >= DEV_LOG_CAP) return;
    g_dev_log[2 * g_dev_log_n] = ea;
    g_dev_log[2 * g_dev_log_n + 1] = kind;
    g_dev_log_n++;
}

// RAW window access — the same rule the EXI model states inline: a device hook must never
// re-enter gk_r*/gk_w*, because those route straight back through GK_RD/GK_WPOST into
// this file (unbounded recursion on the write side, double-counted inventory on the read
// side).  These take a GUEST address and go directly to the backing bytes, big-endian.
static uint32_t dev_p(uint32_t ea) { return GK_HWREG_OFF + (ea - GK_HWREG_LO); }
static uint32_t dev_r16(uint32_t ea) {
    uint8_t *r = g_ram + dev_p(ea);
    return ((uint32_t)r[0] << 8) | r[1];
}
static void dev_w16(uint32_t ea, uint32_t v) {
    uint8_t *r = g_ram + dev_p(ea);
    r[0] = (uint8_t)(v >> 8); r[1] = (uint8_t)v;
}
static uint32_t dev_r32(uint32_t ea) {
    uint8_t *r = g_ram + dev_p(ea);
    return ((uint32_t)r[0] << 24) | ((uint32_t)r[1] << 16) | ((uint32_t)r[2] << 8) | r[3];
}
// Does an access of n bytes at ea touch the rsz-byte register at reg?  A 32-bit guest
// store to 0xCC005028 covers AR_DMA_CNT_H *and* _LO, and it is the LO half that starts
// the transfer on hardware (DSP.cpp:307-315) — so the test has to be overlap, not equality.
static int dev_hits(uint32_t ea, uint32_t n, uint32_t reg, uint32_t rsz) {
    return ea < reg + rsz && reg < ea + n;
}

// The ARAM DMA, zero-latency.  Dolphin's Do_ARAM_DMA byte-swaps on the way in and out
// because its ARAM buffer is host-endian; MEM1 here is already GUEST bytes (gk_r32
// assembles big-endian on every access), so ARAM holds guest bytes too and the transfer
// is a memcpy.  The 0x3ffffff masks are Dolphin's, and its comment gives the reason:
// "Incoming data into ARAM is mirrored every 64MB (verified on real HW)".
static void dsp_aram_dma(void) {
    uint32_t mm  = dev_r32(AR_DMA_MMADDR_EA) & 0x03FFFFFFu;
    uint32_t ar  = dev_r32(AR_DMA_ARADDR_EA) & 0x03FFFFFFu;
    uint32_t cnt = dev_r32(AR_DMA_CNT_EA);
    uint32_t len = cnt & 0x7FFFFFFFu;      // DSP.h:114-122  count:31, dir:1
    uint32_t dir = cnt >> 31;              // 0: MRAM -> ARAM   1: ARAM -> MRAM
    if (!g_aram) g_aram = (uint8_t *)calloc(1, ARAM_SIZE);
    // A transfer that would leave either buffer is DROPPED, not clamped, and the status
    // bit is still raised — because that is what the hardware does with an out-of-range
    // ARAddr too (Dolphin falls through to the HSP path and moves nothing).  The bytes
    // actually moved are counted separately so "the DMA completed" and "the DMA moved
    // data" can never be confused for one another from the outside.
    if (g_aram && len && mm + len <= g_ram_size && (ar & ARAM_MASK) + len <= ARAM_SIZE) {
        if (dir) memcpy(g_ram + mm, g_aram + (ar & ARAM_MASK), len);
        else     memcpy(g_aram + (ar & ARAM_MASK), g_ram + mm, len);
        g_aram_bytes += len;
    }
    g_dsp_ctrl = (g_dsp_ctrl & ~DSPC_DMASTATE) | DSPC_ARAM;
    dev_w16(DSP_CONTROL_EA, g_dsp_ctrl);
    g_dsp_events++;
    dev_log(AR_DMA_CNT_EA, DEVK_DSP_ARAM);
}

// DSP_CONTROL write.  The guest has already stored its 16 bits into the window; this
// turns them into the value a DSP would leave there.
static void dsp_ctrl_write(void) {
    uint32_t w   = dev_r16(DSP_CONTROL_EA);
    uint32_t old = g_dsp_ctrl;
    uint32_t eff = w;

    // AID / ARAM / DSP are WRITE-1-TO-CLEAR status, so a 0 must PRESERVE the old bit
    // rather than clear it (DSP.cpp:285-291: `if (tmpControl.AID) control.AID = 0;`).
    // This is the one thing a backing buffer gets wrong on its own, and it is exactly the
    // bit __OSInitAudioSystem's ARAM handshake polls.
    eff = (eff & ~DSPC_INT_BITS) | (old & DSPC_INT_BITS & ~w);
    // Device-owned status the CPU cannot assert: a DMA is never outstanding here, and
    // DSPInitCode is set and cleared by the DSP itself (see the DSPInit edge below).
    eff &= ~(DSPC_DMASTATE | DSPC_INITCODE);

    if (w & DSPC_RESET) {
        eff &= ~DSPC_RESET;                       // DSP.h:49 / DSPHLE.cpp:206-210
        // A reset is `SetUCode(UCODE_ROM)` (DSPHLE.cpp:208), which clears the pending
        // queue and then lets the BOOT ROM mail 0x8071FEED — it does NOT leave the
        // mailbox empty.  The latched m_last_mail is not cleared by SetUCode either.
        g_dsp_mail_q = DSP_ROM_MAIL; g_dsp_mail_pending = 1;
        g_dsp_events++;
        dev_log(DSP_CONTROL_EA, DEVK_DSP_RESET);
    }
    // DSPInit 1 -> 0 is the ucode load.  DSPHLE.cpp:214-227 — and note the direction: it
    // is CLEARING the bit that starts the DSP, which is why the mail cannot be queued at
    // reset time (step 2 of the sequence above spins until the mailbox is EMPTY).
    if ((old & DSPC_INIT) && !(w & DSPC_INIT)) {
        g_dsp_mail_q = DSP_INIT_MAIL;
        g_dsp_mail_pending = 1;
        g_dsp_events++;
        dev_log(DSP_CONTROL_EA, DEVK_DSP_MAIL);
    }
    g_dsp_ctrl = eff;
    dev_w16(DSP_CONTROL_EA, eff);
}

// DSP -> CPU mailbox read, staged into the window before the guest's load completes.
// MailHandler.cpp:37-70 verbatim: the HIGH read LATCHES the pending mail without
// consuming it, the LOW read consumes it and then clears bit 0x80000000 of the latched
// value, and while the DSP is HALTED neither sees anything new.
static void dsp_mail_read(int low) {
    if (!(g_dsp_ctrl & DSPC_HALT) && g_dsp_mail_pending) {
        g_dsp_mail = g_dsp_mail_q;
        if (low) g_dsp_mail_pending = 0;
        g_dsp_events++;
        dev_log(low ? DSP_MAIL_FROM_LO : DSP_MAIL_FROM_HI, DEVK_DSP_MAIL);
    }
    if (low) g_dsp_mail &= ~0x80000000u;
    dev_w16(DSP_MAIL_FROM_HI, g_dsp_mail >> 16);
    dev_w16(DSP_MAIL_FROM_LO, g_dsp_mail & 0xFFFFu);
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
    // THE READ SIDE HAS TO EXIST FOR THE DSP AND DID NOT FOR EXI.  GK_RD runs BEFORE the
    // load (gekko_rt.h:320-326), so staging here is what the guest's `lhz` then reads.
    // EXI needed none of this because its one modelled bit is written by the CPU and
    // cleared in place; the DSP's control word and mailbox are DEVICE-owned values that
    // no guest store ever put in the buffer.
    if (g_dsp_model) {
        uint32_t ea = GK_HWREG_LO + off;
        if (dev_hits(ea, n, DSP_CONTROL_EA, 2))   dev_w16(DSP_CONTROL_EA, g_dsp_ctrl);
        // Order matters and is hardware's: a 32-bit read of 0xCC005004 is two halfword
        // reads, high first (DSP.cpp:355-359 ReadToSmaller), and only the low one pops.
        if (dev_hits(ea, n, DSP_MAIL_FROM_HI, 2)) dsp_mail_read(0);
        if (dev_hits(ea, n, DSP_MAIL_FROM_LO, 2)) dsp_mail_read(1);
    }
    if (g_watchdog && g_dev_rd_n > g_watchdog) dev_watchdog();
}

void gk_dev_write(uint32_t p, uint32_t n) {
    uint32_t off = p - GK_HWREG_OFF;
    if (off >= GK_HWREG_SIZE) return;
    g_dev_wr_n++;
    if (!g_dev_seen_wr[off]) { g_dev_seen_wr[off] = 1; dev_log(GK_HWREG_LO + off, 2); }
    uint32_t ea = GK_HWREG_LO + off;
    // TWO INDEPENDENT MODELS, TWO INDEPENDENT SWITCHES.  Each `if` is its own falsifying
    // control arm; neither early-returns past the other, so a run can turn off exactly one.
    if (g_exi_model) {
        // EXI CR of any of the three channels, written with TSTART set: complete instantly.
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
    if (g_dsp_model) {
        if (dev_hits(ea, n, DSP_CONTROL_EA, 2))    dsp_ctrl_write();
        if (dev_hits(ea, n, AR_DMA_CNT_LO_EA, 2))  dsp_aram_dma();
    }
}

EMSCRIPTEN_KEEPALIVE uint32_t *sr_image_dev_log(void)   { return g_dev_log; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_dev_log_n(void) { return g_dev_log_n; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_dev_reads(void) { return g_dev_rd_n; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_dev_writes(void){ return g_dev_wr_n; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_exi_clears(void){ return g_exi_clears; }
// The falsifying control arms: 0 restores the pure-backing-buffer behaviour for that ONE
// device, so a claim that either model unblocked something must FAIL with it off — on the
// same binary and the same md5, with no relink standing between the two readings.
EMSCRIPTEN_KEEPALIVE void      sr_image_set_exi_model(uint32_t on) { g_exi_model = on; }
EMSCRIPTEN_KEEPALIVE void      sr_image_set_dsp_model(uint32_t on) { g_dsp_model = on; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_dsp_events(void) { return g_dsp_events; }
// Kept SEPARATE from the event count on purpose: "the DMA reported complete" and "the DMA
// moved bytes" are different claims and a single counter would let one be quoted as the
// other.  0 events with nonzero bytes is impossible; nonzero events with 0 bytes is not.
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_aram_bytes(void) { return g_aram_bytes; }
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
        // SPR 22 IS THE DECREMENTER AND IT IS NOT AN INERT SLOT.  0x800e34bc is
        // PPCMtdec (`7c7603a6 mtspr 22,r3`) — sab.map's "PPCMtwpar" is wrong; WPAR is
        // SPR 921.  Routing it into g_spr[] would make the write a DEAD STORE that
        // nothing counts down, i.e. a second, silent clock alongside sr_host_os.c's.
        // The decrementer is slaved to the same retired-guest-work tick source as the
        // timebase (sr_host_os.h "THE GUEST TIMEBASE"), so it belongs there.
        // ⚠ Its INTERRUPT is still not delivered — sr_tb_dec_exceptions() counts what
        // would have fired — because this runtime has no interrupt delivery at all.
        // SPR 1008 IS HID0 AND IT HAS A SECOND READER.  gk_sc() (gekko_rt.h) needs it,
        // because DOLSDK's `sc` vector is `mfspr r9,HID0 / ori r10,r9,8 / ...` and both
        // registers survive the rfi.  Routing HID0 into this file's private g_spr[]
        // would put the guest's value where the emitted code cannot see it — the same
        // two-owners-one-quantity mistake the clock made — so there is ONE HID0,
        // g_hid0, declared in gekko_rt.h and seeded with the BS2 boot value.
        if      (spr == 22u   && xo == 339u) st->gpr[rt] = sr_dec_read();
        else if (spr == 22u   && xo == 467u) sr_dec_write(st->gpr[rt]);
        else if (spr == 1008u && xo == 339u) st->gpr[rt] = g_hid0;
        else if (spr == 1008u && xo == 467u) g_hid0 = st->gpr[rt];
        else if (xo == 339u) st->gpr[rt] = g_spr[spr & 1023u];   // mfspr
        else if (xo == 467u) g_spr[spr & 1023u] = st->gpr[rt];   // mtspr
        else { img_log(addr, IMG_D_UNIMPL);
               if (!g_fault) g_fault = SR_F_IMG_UNIMPL | (addr & 0x00ffffffu);
               return 1; }
        img_log(addr, IMG_D_REAL);
        return 1;
    }

    // ---- CACHE CONTROL — what is LEFT of it.  ⚠ THIS LIST SHRANK on 2026-09-04 and
    // the shrink is the point: the cache-maintenance INSTRUCTIONS are now emitted (dcbi
    // and the rest of CACHE_NOP_XO as no-ops, `sc` as gk_sc(), dcbz_l as a real store —
    // see the long notes at the top of sr.py and beside gk_sc in gekko_rt.h), so
    // PPCSync 0x800e34c4, DCInvalidateRange 0x800e4e1c, DCFlushRange 0x800e4e4c,
    // DCStoreRange 0x800e4e80 and the four locked-cache allocators 0x8014b504 /
    // 0x8014b5bc / 0x8014b680 / 0x8014b7ac are TRANSLATED now and no longer reach this
    // hook at all.  Answering for them HERE would have been strictly worse than
    // translating them: each of those bodies is a counted loop that leaves r3, r4, r5,
    // CTR and CR0 changed, verify_fixture.mjs scores all 32 GPRs plus cr/lr/ctr
    // (:521-543), and a host stub that "does nothing" would leave every one of them at
    // its entry value.  A no-op instruction inside the real loop is exact; a no-op
    // FUNCTION is not.
    //
    // What remains is the set the translator still refuses for a DIFFERENT reason —
    // privileged SPR access (HID0 / HID2 / DBAT), not cache maintenance:
    //   0x800e4e08 DCEnable          mfspr/mtspr HID0    (OSCache.c:22-29)
    //   0x800e4f4c ICFlashInvalidate mfspr/mtspr HID0    (:251-257)
    //   0x800e4f5c ICEnable          mfspr/mtspr HID0    (:259-266)
    //   0x800e4f70 __LCEnable        mfmsr + HID2 + DBAT3 (:309-369)
    //   0x800e5074 LCDisable         dcbi loop + HID2     (:380-393)
    // The LOCKED CACHE those last two manage is ORDINARY MEMORY here (README §5k,
    // gekko_rt.h:61-71) and is backed by the tail buffer whether or not it has been
    // "enabled", so voiding the enable/disable pair changes no memory the guest can
    // observe.  DCEnable / ICEnable / ICFlashInvalidate ARE modelled rather than
    // voided: their whole body is `HID0 |= bit`, HID0 has one owner (g_hid0), and the
    // guest reads it back through PPCMfhid0 — and `sc` reads it too.
    //
    // ⚠ THE ONE THING NONE OF THIS COVERS, unchanged: a guest that uses DCFlushRange to
    // publish a buffer to a DMA engine is relying on an ordering this runtime cannot
    // violate (there is one memory), but a guest that uses DCInvalidateRange to RE-READ
    // a buffer a DMA engine wrote is relying on the DMA having happened — and no DMA
    // engine is modelled.  That failure surfaces as wrong data, not as a fault here.
    case 0x800e4e08u: g_hid0 |= 0x00004000u;   // DCEnable          HID0[DCE]
                      img_log(addr, IMG_D_REAL); return 1;
    case 0x800e4f5cu: g_hid0 |= 0x00008000u;   // ICEnable          HID0[ICE]
                      img_log(addr, IMG_D_REAL); return 1;
    case 0x800e4f4cu: g_hid0 |= 0x00000800u;   // ICFlashInvalidate HID0[ICFI]
                      img_log(addr, IMG_D_REAL); return 1;
    // __LCEnable is NOT void, and `sr.py --cache-audit` is what caught that.  Its body
    // ends in OSCache.c:349-352 `_lockloop`: 512 x `dcbz_l`, which is a REAL 32-byte
    // store, and a stub that returns without performing them drops 16 KB of zeroing.
    // It happens to be invisible on a COLD boot -- sr_driver.c calloc()s the tail
    // buffer, so the locked cache is already zero -- but it would NOT be invisible on
    // an enable that follows a disable, and "correct by accident of the allocator" is
    // not a semantics.  LC_BASE_PREFIX 0xE000 and LC_LINES 512 are OSCache.c's own.
    // ⚠ STILL NOT REPRODUCED, named rather than implied: the register tail.  The real
    // body leaves r3 = 0xE0004000, r4 = HID2|0x100f0000, r5 = MSR|0x1000, r6 = 0 and
    // CTR = 0, and it sets MSR[ME], HID2[LCE] and DBAT3.  All five registers are
    // volatile under the ABI and LCEnable 0x800e503c -- its only caller -- reads none
    // of them afterwards, so no guest code sees it; a fixture differential would.
    case 0x800e4f70u:   // __LCEnable
        for (uint32_t i = 0; i < 512u; i++) gk_dcbz(0xE0000000u + i * 32u);
        img_log(addr, IMG_D_REAL);
        return 1;
    case 0x800e5074u:   // LCDisable — its only cache site is a dcbi loop, and dcbi has
                        // nothing to discard here (sr.py CACHE_NOP_XO).  The locked
                        // cache stays exactly as modelled memory, which is what README
                        // §5k established it is whether or not it has been "enabled".
        img_log(addr, IMG_D_VOID);
        return 1;

    // ---- 0x800ecb48 OSGetTime / 0x800ecb60 OSGetTick ARE NOT ANSWERED HERE ANY MORE.
    // They were, and this file's own COLLISION WATCH said to delete them the moment
    // sr_host_os.c grew a clock.  f33b3795 did exactly that, and img_timebase() was
    // pointed at sr_tb_read() — but leaving the CASES here kept THIS layer winning,
    // because img_hook asks img_host() before sr_host_call().  The values agreed, so
    // nothing looked wrong; what was silently lost is everything the shared
    // implementation adds AROUND the value — tb_read_guard's SR_F_TB_STALL, the
    // SR_EV_GET_TIME / SR_EV_GET_TICK trace, and the g_tb_calls count.  A frozen clock
    // has to be LOUD (sr_host_os.h "THE STALL FAULT"), and it cannot be loud from a
    // layer that does not count reads.  There is now ONE owner: sr_host_os.c.

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
// ⚠ COLLISION WATCH — RESOLVED 2026-09-04, and the resolution is worth keeping because
// the collision was INVISIBLE while it was live.  This file used to answer OSGetTime /
// OSGetTick at 0x800ecb48 / 0x800ecb60 as well as sr_host_os.c, and because img_host()
// is asked FIRST, this layer won every time.  Both returned the same number
// (img_timebase() had already been pointed at sr_tb_read() by f33b3795), so no test and
// no log could tell — what was lost was everything the owning layer wraps around the
// value: the SR_F_TB_STALL guard, the SR_EV_GET_TIME/GET_TICK trace and the read count.
// The cases are gone; sr_host_os.c owns the clock alone.  The standing rule that made
// this findable: for any quantity BOTH layers could answer for, delete the case here
// rather than reordering the hook — sr_host_os.c is the layer that also owns the
// decrementer and the faults, and a quantity split across two owners is how a timing
// bug becomes unattributable.  HID0 was the next one in line and is handled the same
// way, by having exactly one variable (g_hid0) rather than one per layer.
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
