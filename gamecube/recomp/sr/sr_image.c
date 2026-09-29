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
void         sr_os_mode(int m);
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
// [2026-09-29] THE QUEUE IS NOW MailHandler's OWN SHAPE (DSPHLE/MailHandler.cpp:18-70): a
// FIFO of (mail, interrupt-on-pop) pairs.  The one-slot version above was exact for the two
// ucodes that each push one mail; the boot task and the AX ucode that follow it push mails
// WITH a DSP interrupt, and the interrupt is attached to the FRONT mail (PushMail, :20-30),
// which a single slot cannot represent.  Power-on: the ROM ucode's 0x8071FEED (see above).
#define DSP_MQ 32
static uint32_t g_mq_mail[DSP_MQ] = { DSP_ROM_MAIL };
static uint8_t  g_mq_irq[DSP_MQ];
static uint32_t g_mq_head = 0, g_mq_n = 1;
#define SR_F_DSP_MQ 0xC6C00000u         // more than DSP_MQ mails queued: raise, never drop
static void mq_clear(void) { g_mq_n = 0; }
static void dsp_gen_int(void);          // DSP.cpp:389-396, defined after irq_update
// MailHandler::PushMail(mail, interrupt, cycles_into_future): with an empty queue the DSP
// interrupt is SCHEDULED that many cycles out (GenerateDSPInterruptFromDSPEmu, DSP.cpp:399-404).
static uint64_t g_dsp_int_at = UINT64_MAX;
static void ev_rearm(void);
static void mq_push_delay(uint32_t mail, int irq, uint32_t cycles) {
    if (irq) {
        if (g_mq_n) g_mq_irq[g_mq_head] = 1;
        else if (!cycles) dsp_gen_int();
        else { uint64_t at = g_gk_cycles + cycles; if (at < g_dsp_int_at) g_dsp_int_at = at; ev_rearm(); }
    }
    if (g_mq_n == DSP_MQ) { if (!g_fault) g_fault = SR_F_DSP_MQ; return; }
    uint32_t i = (g_mq_head + g_mq_n) % DSP_MQ;
    g_mq_mail[i] = mail; g_mq_irq[i] = 0; g_mq_n++;
}
static void mq_push(uint32_t mail, int irq) {
    if (irq) { if (!g_mq_n) dsp_gen_int(); else g_mq_irq[g_mq_head] = 1; }
    if (g_mq_n == DSP_MQ) { if (!g_fault) g_fault = SR_F_DSP_MQ; return; }
    uint32_t i = (g_mq_head + g_mq_n) % DSP_MQ;
    g_mq_mail[i] = mail; g_mq_irq[i] = 0; g_mq_n++;
}
static void ucode_set(uint32_t which);  // DSPHLE::SetUCode — THE NEXT DEVICES, id 7
static void aid_reset(void);            // THE NEXT DEVICES, id 8
void sr_ax_command_list(uint32_t addr, uint16_t size);   // sr_ax.c, id 9
static uint32_t g_dsp_events = 0;   // modelled DSP actions taken — the ON-arm's witness
static uint32_t g_aram_bytes = 0;   // bytes actually moved by a modelled ARAM DMA
static uint8_t *g_aram = 0;         // allocated on the first DMA, never before
uint8_t *sr_image_aram_ptr(void) {  // sr_ax.c's accelerator reads it (DSP::ReadARAM)
    if (!g_aram) g_aram = (uint8_t *)calloc(1, 0x01000000u);
    return g_aram;
}

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

// The ARAM DMA, zero-latency — [2026-09-29] NOW A TRANSCRIPTION OF Do_ARAM_DMA, not a memcpy.
// Every rule below is ~/dolphin-upstream (0cd3bb89c2) Source/Core/Core/HW/DSP.cpp, and each
// one matters to __ARChecksize (0x800f6320), which is the first code after OSInit that reads
// ARAM BACK and decides the machine's ARAM size from what it sees:
//   * the address registers are MASKED on write (DSP.cpp:166-201 directly_mapped_vars):
//     _H halves keep 0x03ff, _L halves keep 0xffe0, CNT_H also keeps the dir bit 0x8000.
//   * both addresses are masked to 0x3ffffff ("mirrored every 64MB", :476-477 / :525-526).
//   * ARAddr < m_aram.size (16 MB on GC) goes to ARAM at `ARAddr & mask` (:479 / :528).
//   * ARAddr >= size on GC goes to the HSP (:506-515 / :558-567).  With no HSP device —
//     MAIN_HSP_DEVICE defaults to None (Config/MainSettings.cpp:252-253) — HSPManager::Read
//     RETURNS 0 and Write is DISCARDED (HSP/HSP.cpp:27-40).  So an out-of-range ARAM->MRAM
//     transfer WRITES ZEROS into MRAM.  The previous model dropped it and left MRAM alone,
//     which is exactly the difference an ARAM size probe measures.
//   * AR_INFO mode 4 (`(m_aram_info.Hex & 0xf) == 4`) additionally mirrors an MRAM->ARAM
//     write below 0x400000 to +0x400000 (:537-546).  __ARChecksize runs in that mode.
//   * the transfer walks in 8-byte steps and leaves MMAddr/ARAddr advanced and count 0
//     (:501-503 / :553-555); those are the values the registers READ BACK afterwards.
// MEM1 here is already GUEST byte order and so is ARAM, so each 8-byte step is a copy; the
// swap64 pairs in Dolphin exist because its ARAM is host-endian.  Completion is immediate
// (the reference schedules CompleteARAM `(count/32)*246` ticks later, :464-465) — the same
// zero-latency statement the DSPReset and TSTART models make.  MMAddr beyond MEM1 is not
// memory this runtime has (Dolphin's Memory::Write_U64 would hit its own unmapped path), so
// such a step RAISES a named fault instead of guessing.
#define SR_F_ARAM_MM_RANGE 0xC6A00000u
static void irq_update(void);   // THE INTERRUPT LAYER, below
static void dev_w32(uint32_t ea, uint32_t v) {
    dev_w16(ea, v >> 16); dev_w16(ea + 2, v & 0xFFFFu);
}
static void dsp_aram_dma(void) {
    uint32_t mm  = ((dev_r16(AR_DMA_MMADDR_EA) & 0x03FFu) << 16) | (dev_r16(AR_DMA_MMADDR_EA + 2) & 0xFFE0u);
    uint32_t ar  = ((dev_r16(AR_DMA_ARADDR_EA) & 0x03FFu) << 16) | (dev_r16(AR_DMA_ARADDR_EA + 2) & 0xFFE0u);
    uint32_t cnt = ((dev_r16(AR_DMA_CNT_EA) & 0x83FFu) << 16) | (dev_r16(AR_DMA_CNT_LO_EA) & 0xFFE0u);
    uint32_t len = cnt & 0x7FFFFFFFu;      // DSP.h:114-122  count:31, dir:1
    uint32_t dir = cnt >> 31;              // 0: MRAM -> ARAM   1: ARAM -> MRAM
    uint32_t mode = dev_r16(0xCC005012u) & 0xFu;   // AR_INFO, masked 0x7f on write (:167)
    if (!g_aram) g_aram = (uint8_t *)calloc(1, ARAM_SIZE);
    ar &= 0x03FFFFFFu; mm &= 0x03FFFFFFu;
    while (len) {
        if (mm + 8u > g_ram_size) { if (!g_fault) g_fault = SR_F_ARAM_MM_RANGE | (mm >> 8); break; }
        if (dir) {
            if (ar < ARAM_SIZE) memcpy(g_ram + mm, g_aram + (ar & ARAM_MASK), 8);
            else                memset(g_ram + mm, 0, 8);                 // HSP None: Read -> 0
            g_aram_bytes += 8;
        } else if (ar < ARAM_SIZE) {
            if (mode == 4u && ar < 0x400000u)
                memcpy(g_aram + ((ar + 0x400000u) & ARAM_MASK), g_ram + mm, 8);
            memcpy(g_aram + (ar & ARAM_MASK), g_ram + mm, 8);
            g_aram_bytes += 8;
        }                                                                 // else HSP None: discarded
        mm += 8; ar += 8; len -= 8;
    }
    dev_w32(AR_DMA_MMADDR_EA, mm);
    dev_w32(AR_DMA_ARADDR_EA, ar);
    dev_w32(AR_DMA_CNT_EA, (dir << 31) | len);
    g_dsp_ctrl = (g_dsp_ctrl & ~DSPC_DMASTATE) | DSPC_ARAM;
    dev_w16(DSP_CONTROL_EA, g_dsp_ctrl);
    g_dsp_events++;
    dev_log(AR_DMA_CNT_EA, DEVK_DSP_ARAM);
    irq_update();
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
        ucode_set(0);                               // UCODE_ROM: clear, push 0x8071FEED
        aid_reset();                                // DSP.cpp:266-270: reset clears AudioDMAControl
        g_dsp_events++;
        dev_log(DSP_CONTROL_EA, DEVK_DSP_RESET);
    }
    // DSPInit 1 -> 0 is the ucode load.  DSPHLE.cpp:214-227 — and note the direction: it
    // is CLEARING the bit that starts the DSP, which is why the mail cannot be queued at
    // reset time (step 2 of the sequence above spins until the mailbox is EMPTY).
    if ((old & DSPC_INIT) && !(w & DSPC_INIT)) {
        ucode_set(1);                               // UCODE_INIT_AUDIO_SYSTEM: push 0x80544348
        g_dsp_events++;
        dev_log(DSP_CONTROL_EA, DEVK_DSP_MAIL);
    }
    g_dsp_ctrl = eff;
    dev_w16(DSP_CONTROL_EA, eff);
    irq_update();      // the mask bits may have changed: DSP.cpp:301 UpdateInterrupts()
}

// DSP -> CPU mailbox read, staged into the window before the guest's load completes.
// MailHandler.cpp:37-70 verbatim: the HIGH read LATCHES the pending mail without
// consuming it, the LOW read consumes it and then clears bit 0x80000000 of the latched
// value, and while the DSP is HALTED neither sees anything new.
static void dsp_mail_read(int low) {
    if (!(g_dsp_ctrl & DSPC_HALT) && g_mq_n) {
        g_dsp_mail = g_mq_mail[g_mq_head];
        if (low) {
            int gen = g_mq_irq[g_mq_head];
            g_mq_head = (g_mq_head + 1) % DSP_MQ; g_mq_n--;
            if (gen) dsp_gen_int();
        }
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

static void dev_read_models(uint32_t ea, uint32_t n);
static void dev_write_models(uint32_t ea, uint32_t n);

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
    dev_read_models(GK_HWREG_LO + off, n);   // [2026-09-29] AR / PI / VI, below
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
    dev_write_models(ea, n);                 // [2026-09-29] AR / PI / VI, below
}

// ======================================================= [2026-09-29] THE NEXT DEVICES
//
// Everything in this block was added because the WHOLE-IMAGE boot (build_image.sh --all,
// SR_SPLIT build, run under node by run_image_node.mjs) reached it — README §10.6 has the
// trajectory, one row per wall.  Each piece is SWITCHABLE AT RUN TIME through
// sr_image_set_model(id, on), so each claim has its falsifying control arm on ONE binary
// with ONE md5, the discipline the EXI and DSP models already follow.  Citations are to
// ~/dolphin-upstream at 0cd3bb89c2 (Source/Core/Core/...) and to the public SDK decomp
// github.com/doldecomp/dolsdk2001 (src/...).
//
//   id 1  AR    ARAM controller registers that are not the DMA: AR_MODE is READ-ONLY and
//               reads 1 ("ARAM Controller has init'd", HW/DSP.cpp:148, registered with
//               WMASK_NONE at :183); AR_REFRESH powers on at 156 (:149) and keeps 0x07ff of
//               a write (:168, :187).  __ARChecksize (0x800f6320) spins on
//               `while (!(__DSPRegs[11] & 1))` (dolsdk2001 src/ar/ar.c:222) — i.e. on AR_MODE.
//   id 2  RM    RealMode(fn) at 0x800e8a4c, the `rfi`-into-physical-mode trampoline that
//               __OSInitMemoryProtection (0x800e8a64) uses to run Config24MB/Config48MB.  The
//               translator refuses it (mtspr SRR0).  It is INTERPRETED from the shipped words,
//               with a whitelist of the opcodes those BAT-configuration bodies are made of;
//               any other opcode RAISES.  Nothing is skipped: the BAT writes land in the SPR
//               file, the MSR round trip is performed, and the final `rfi` must return to the
//               caller's LR or it raises too.
//   id 3  IRQ   THE INTERRUPT PATH.  PI INTSR/INTMR as the device (ProcessorInterface.cpp),
//               the external-interrupt and decrementer exceptions ENTERED the way the CPU and
//               DOLSDK's first-level vector enter them (PowerPC.cpp:583-632, dolsdk2001
//               src/os/OS.c:344-420), the guest's OWN second-level handler and dispatcher run
//               translated, and the handler's closing OSLoadContext(context) performed as a
//               real non-returning context load (setjmp/longjmp to the live delivery frame).
//   id 4  PIREV PI_FLIPPER_REV reads FLIPPER_REV_C = 0x246500B1 (ProcessorInterface.cpp:29,
//               :136).  OSInit adds its top nibble to BootInfo->consoleType
//               (dolsdk2001 src/os/OS.c OSInit, `__PIRegs[11] & 0xF0000000`).
//   id 5  VI    the video interface's TIMING and its four display interrupts: the Preset
//               register values (VideoInterface.cpp:95-178), the half-line counter advanced by
//               RETIRED GUEST CYCLES at GetTicksPerHalfLine() (:760-773), IR_INT raised at
//               VCT/HCT (:989-1001) and the PI VI line (:435-447).  NO PIXELS: no XFB is
//               scanned out and nothing is drawn — this is the clock the guest's
//               VIWaitForRetrace sleeps on, not a display.
//   id 6  AI    the audio interface's streaming SAMPLE COUNTER and its interrupt
//               (AudioInterface.cpp, whole file): AICR, AISCNT, AIIT, clocked by RETIRED GUEST
//               CYCLES at 486e6 * divisor / 108e6 cycles per sample (divisors 2248 / 3372 on GC,
//               :348-356; Mixer.h:58).  __AI_SRC_INIT (dolsdk2001 src/ai/ai.c:365-421) measures
//               the counter's edges against OSGetTime, so the counter and the timebase MUST be
//               the same clock — which they are: both are g_gk_cycles.  NO SAMPLES: no stream
//               audio is decoded and nothing is mixed.
//   id 7  UCODE the CPU->DSP mailbox and the DSP-side ucode STATE MACHINES, HLE'd exactly as
//               Dolphin's default (MAIN_DSP_HLE) configuration HLEs them: writing
//               MAIL_TO_DSP_LO hands the mail to the current ucode and clears the MSB
//               (DSPHLE/DSPHLE.cpp:179-190); the boot ROM collects the boot-task parameters
//               and, on 0x80F3D001, hashes the uploaded IRAM image with HashEctor and switches
//               to the ucode that hash names (UCodes/ROM.cpp HandleMail/BootUCode,
//               Common/Hash.cpp:33-44, UCodes/UCodes.cpp UCodeFactory).  Of the ucodes that
//               can be chosen, ONLY the AX mail protocol is modelled, and only up to its first
//               COMMAND LIST: AX's command processing (voice parameter blocks, mixing) is not,
//               and reaching it RAISES SR_F_DSP_AXCMD rather than acknowledging work that was
//               never done.  An unknown hash RAISES too (the reference panics there).
//   id 8  AID   the DSP interface's AUDIO DMA (the CPU->AI sample FIFO): START/CONTROL/
//               BLOCKS_LEFT (HW/DSP.cpp:314-361), the per-32-byte-block walk
//               UpdateAudioDMA (:424-454) on SystemTimers' AudioDMACallback period
//               (SystemTimers.cpp:78-94: 486e6 * AID divisor / 13.5e6 cycles — 121,392 at
//               32 kHz), and the AID interrupt: 200 cycles after enable (:342-346) and on each
//               buffer wrap.  NO SAMPLES LEAVE: Dolphin's SendAIBuffer (the speaker) has no
//               counterpart here, so the blocks are walked and discarded.
//   id 9  AXCMD the AX ucode's COMMAND LIST processing — sr_ax.c, a transcription of
//               UCodes/AX.cpp + AXVoice.h + DSPAccelerator.cpp for ucode 0x4e8a8b21 — and the
//               work-end mail DSP_YIELD with its interrupt 2,500 cycles later (AX.cpp:92-111).
//               OFF restores SR_F_DSP_AXCMD, the wall it removes.
//   id 10 DI    the DVD interface (HW/DVD/DVDInterface.cpp): DISR/DICVR/DICMDBUF/DIMAR/
//               DILENGTH/DICR/DIIMMBUF/DICFG with their write masks (:548-631), the power-on
//               state after an emulated BS2 (:262-277, :533; Boot.cpp:366 ReadyNoReadsMade),
//               ExecuteCommand for Inquiry / Read sector / Read disc ID / Seek / RequestError /
//               StopMotor / AudioBufferConfig (:783-1213), CheckReadPreconditions and the
//               block-out-of-bounds check (:705-780), FinishExecutingCommand (:1307-1348) and
//               the TCINT/DEINT interrupt (:633-665).  The DATA is read from the ISO itself
//               (sr_image_set_disc; the whole disc is the "mini DVD" 1,459,978,240 bytes, which
//               is exactly MINI_DVD_SIZE).  TIMING: every command completes after the
//               reference's MINIMUM_COMMAND_LATENCY_US = 300 us (:52, :1204-1211); the
//               reference's seek/read-rate model for READS (ScheduleReads / DVDMath) is NOT
//               reproduced, so reads complete faster than on hardware — stated, not hidden.
//               DTK audio streaming (0xE1/0xE2) RAISES.
#include <setjmp.h>
#include <stdio.h>
#define MODEL_AR    1u
#define MODEL_RM    2u
#define MODEL_IRQ   3u
#define MODEL_PIREV 4u
#define MODEL_VI    5u
#define MODEL_AI    6u
#define MODEL_UCODE 7u
#define MODEL_AID   8u
#define MODEL_AXCMD 9u
#define MODEL_DI    10u
static uint32_t g_model_on = (1u << MODEL_AR) | (1u << MODEL_RM) | (1u << MODEL_IRQ) |
                             (1u << MODEL_PIREV) | (1u << MODEL_VI) | (1u << MODEL_AI) |
                             (1u << MODEL_UCODE) | (1u << MODEL_AID) | (1u << MODEL_AXCMD) |
                             (1u << MODEL_DI);
static int model(uint32_t id) { return (g_model_on >> id) & 1u; }
static uint32_t g_model_events[16];
static uint32_t g_strict;    // defined with its setter next to img_hook (tentative here)
static void ev_rearm(void);
static void tail_mark(uint32_t kind, uint32_t a);   // the tail ring, next to img_hook
EMSCRIPTEN_KEEPALIVE void sr_image_set_model(uint32_t id, uint32_t on) {
    if (id >= 16) return;
    if (on) g_model_on |= 1u << id; else g_model_on &= ~(1u << id);
    ev_rearm();
}
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_get_model(uint32_t id) { return id < 16 ? model(id) : 0; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_model_events(uint32_t id) { return id < 16 ? g_model_events[id] : 0; }

// ---------------------------------------------------------------- fault codes (0xC6Bx)
#define SR_F_RM_OPCODE    0xC6B00000u   // RealMode target contains an opcode outside the whitelist
#define SR_F_RM_RETURN    0xC6B10000u   // RealMode's final rfi did not return to the caller's LR
#define SR_F_IRQ_HANDLER  0xC6B20000u   // exception handler body is not the OS_EXCEPTION_SAVE_GPRS shape
#define SR_F_IRQ_UNRECOV  0xC6B30000u   // SRR1[RI] clear: DOLSDK would take OSDefaultExceptionHandler
#define SR_F_IRQ_NOLOAD   0xC6B40000u   // the guest dispatcher RETURNED without OSLoadContext(context)
#define SR_F_IRQ_NOTRANS  0xC6B50000u   // the dispatcher is not a translated function
#define SR_F_PI_WIDTH     0xC6B60000u   // a non-32-bit access to a PI register (Dolphin: InvalidWrite)

// ------------------------------------------------------------------------ PI
#define PI_INTSR_EA   0xCC003000u
#define PI_INTMR_EA   0xCC003004u
#define PI_REV_EA     0xCC00302Cu
#define PI_CAUSE_DSP  0x00000040u
#define PI_CAUSE_VI   0x00000100u
// ProcessorInterface.cpp:50-57 Init(): mask 0, cause = INT_CAUSE_RST_BUTTON | INT_CAUSE_VI.
static uint32_t g_pi_cause = 0x00010000u | PI_CAUSE_VI;
static uint32_t g_pi_mask  = 0;
static uint32_t g_ext_pending = 0;   // PowerPC's `Exceptions & EXCEPTION_EXTERNAL_INT`
static uint32_t g_dec_pending = 0;   // PowerPC's `Exceptions & EXCEPTION_DECREMENTER`
// ProcessorInterface.cpp:149-156 UpdateException, transcribed: the pending flag is SET or
// CLEARED from cause & mask each time either changes, and CheckExternalExceptions clears it
// when the exception is TAKEN (PowerPC.cpp:602).
static void pi_update(void) {
    g_ext_pending = (g_pi_cause & g_pi_mask) != 0;
    ev_rearm();
}
static void pi_set(uint32_t bit, int on) {       // ProcessorInterface::SetInterrupt
    if (on) g_pi_cause |= bit; else g_pi_cause &= ~bit;
    pi_update();
}
// DSP.cpp:372-382 UpdateInterrupts: each status bit's mask is the bit directly to its left.
static void irq_update(void) {
    if (!model(MODEL_IRQ)) return;
    pi_set(PI_CAUSE_DSP, ((g_dsp_ctrl >> 1) & g_dsp_ctrl & DSPC_INT_BITS) != 0);
}

// DSP.cpp:389-396 GenerateDSPInterrupt(INT_DSP): the status bit is set whatever the mask,
// and UpdateInterrupts decides the PI line.
static void dsp_gen_int(void) {
    g_dsp_ctrl |= DSPC_DSP;
    dev_w16(DSP_CONTROL_EA, g_dsp_ctrl);
    irq_update();
}

// ------------------------------------------------------------------ DSP ucodes (id 7)
#define SR_F_DSP_UCODE  0xC6C10000u   // BootUCode hashed to a ucode this layer has no model of
#define SR_F_DSP_AXCMD  0xC6C20000u   // the AX ucode was handed a command list (not modelled)
#define SR_F_DSP_AXTASK 0xC6C30000u   // an AX task mail this layer does not model (new ucode)
#define UC_ROM  0u
#define UC_INIT 1u
#define UC_AX   2u
static uint32_t g_uc = UC_ROM, g_uc_crc = 0, g_uc_boots = 0;
static uint32_t g_rom_next = 0, g_rom_ram = 0, g_rom_len = 0, g_rom_dmem = 0, g_rom_imem = 0, g_rom_pc = 0;
static uint32_t g_ax_state = 0;       // 0 WaitingForCmdListSize, 1 ...Address, 2 WaitingForNextTask
static uint32_t g_ax_cmdlist_size = 0, g_ax_cmdlist_addr = 0;
static void ucode_set(uint32_t which) {                      // DSPHLE.cpp:71-76 SetUCode
    mq_clear();
    g_uc = which;
    if (which == UC_ROM)  { g_rom_next = 0; mq_push(DSP_ROM_MAIL, 0); }   // ROM.cpp Initialize
    if (which == UC_INIT) mq_push(DSP_INIT_MAIL, 0);                     // INIT.cpp:20-23
    if (which == UC_AX)   { g_ax_state = 0; mq_push(0xDCD10000u, 1); }   // AX.cpp InitializeShared:
                                                                         //   PushMail(DSP_INIT, true)
}
// Common/Hash.cpp:33-44 HashEctor, over guest bytes in memory order.
static uint32_t hash_ector(uint32_t pa, uint32_t len) {
    uint32_t crc = 0;
    for (uint32_t i = 0; i < len; i++) { crc ^= g_ram[pa + i]; crc = (crc << 3) | (crc >> 29); }
    return crc;
}
static void rom_boot_ucode(void) {                            // ROM.cpp BootUCode
    uint32_t pa = g_rom_ram & 0x3FFFFFFFu;
    g_uc_boots++;
    if (pa + g_rom_len > g_ram_size) { if (!g_fault) g_fault = SR_F_DSP_UCODE | 0xFFFFu; return; }
    g_uc_crc = hash_ector(pa, g_rom_len);
    switch (g_uc_crc) {                                       // UCodes.cpp:154-167, the GC AX set
    case 0x3ad3b7acu: case 0x3daf59b9u: case 0x4e8a8b21u: case 0x07f88145u:
    case 0xe2136399u: case 0x3389a79eu:
        ucode_set(UC_AX); g_model_events[MODEL_UCODE]++; return;
    default:
        if (!g_fault) g_fault = SR_F_DSP_UCODE | (g_uc_crc & 0xFFFFu);
        return;
    }
}
static void ucode_mail(uint32_t mail) {                       // DSPHLE.cpp:63-69 SendMailToDSP
    g_model_events[MODEL_UCODE]++;
    if (g_uc == UC_ROM) {                                     // ROM.cpp HandleMail, verbatim
        if (g_rom_next == 0) {
            if ((mail & 0xFFFF0000u) != 0x80F30000u) mq_push(0xFEEE0000u | (mail & 0xFFFFu), 0);
            else g_rom_next = mail;
            return;
        }
        switch (g_rom_next) {
        case 0x80F3A001u: g_rom_ram  = mail; break;
        case 0x80F3A002u: g_rom_len  = mail & 0xFFFFu; break;
        case 0x80F3B002u: g_rom_dmem = mail & 0xFFFFu; break;
        case 0x80F3C002u: g_rom_imem = mail & 0xFFFFu; break;
        case 0x80F3D001u: g_rom_pc   = mail & 0xFFFFu; rom_boot_ucode(); return;
        default: break;
        }
        g_rom_next = 0;
        return;
    }
    if (g_uc == UC_INIT) return;                              // INIT.cpp HandleMail: empty
    if (g_uc == UC_AX) {                                      // AX.cpp HandleMail
        if (g_ax_state == 0) {
            if ((mail & 0xFFFF0000u) == 0xBABE0000u) { g_ax_cmdlist_size = mail & 0xFFFFu; g_ax_state = 1; }
            return;                                           // else: ERROR_LOG only
        }
        if (g_ax_state == 1) {                                // CopyCmdList + HandleCommandList
            g_ax_cmdlist_addr = mail;
            if (!model(MODEL_AXCMD)) {                        // the control arm: the old wall
                if (!g_fault) g_fault = SR_F_DSP_AXCMD | (g_ax_cmdlist_size & 0xFFFFu);
                return;
            }
            sr_ax_command_list(mail, (uint16_t)g_ax_cmdlist_size);
            g_ax_cmdlist_size = 0;
            mq_push_delay(0xDCD10002u, 1, 2500);              // SignalWorkEnd: DSP_YIELD
            g_ax_state = 2;
            g_model_events[MODEL_AXCMD]++;
            return;
        }
        uint32_t m = 0xCDD10000u | (mail & 0xFFFFu);           // "does not check for CDD1"
        if (m == 0xCDD10000u) { mq_push(0xDCD10001u, 1); g_ax_state = 0; }   // MAIL_RESUME -> DSP_RESUME
        else if (m == 0xCDD10002u) ucode_set(UC_ROM);                        // MAIL_RESET
        else if (m == 0xCDD10003u) g_ax_state = 0;                           // MAIL_CONTINUE
        else if (!g_fault) g_fault = SR_F_DSP_AXTASK | (mail & 0xFFFFu);    // MAIL_NEW_UCODE etc.
    }
}
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_ucode_crc(void)  { return g_uc_crc; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_ucode(void)      { return g_uc; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_ax_cmdlist(void) { return g_ax_cmdlist_addr; }

// ------------------------------------------------------------------------ VI
#define VI_BASE 0xCC002000u
static uint32_t g_vi_hl = 0;              // m_half_line_count, VideoInterface.cpp:174
static uint64_t g_vi_next = UINT64_MAX;   // cycle of the next half-line Update()
static uint32_t g_vi_fields = 0;          // half-line counter wraps (one per FRAME)
static uint32_t vi_r16(uint32_t o) { return dev_r16(VI_BASE + o); }
static uint32_t vi_r32(uint32_t o) { return dev_r32(VI_BASE + o); }
// VideoInterface.cpp:760-773: 2 * ticks/s / CLOCK_FREQUENCIES[clock & 1] * HLW; the
// frequencies are 27 MHz and 54 MHz and ticks/s is the 486 MHz CPU clock.
static uint32_t vi_ticks_per_half_line(void) {
    uint32_t per_sample = 2u * 486000000u / ((vi_r16(0x6C) & 1u) ? 54000000u : 27000000u);
    return per_sample * (vi_r32(0x04) & 0x3FFu);
}
// :467-477 GetHalfLinesPerEvenField/OddField.
static uint32_t vi_half_lines_per_frame(void) {
    uint32_t vtr = vi_r16(0x00), equ = vtr & 0xFu, acv = (vtr >> 4) & 0x3FFu;
    uint32_t vto = vi_r32(0x0C), vte = vi_r32(0x10);
    return (3u * equ + (vte & 0x3FFu) + 2u * acv + ((vte >> 16) & 0x3FFu)) +
           (3u * equ + (vto & 0x3FFu) + 2u * acv + ((vto >> 16) & 0x3FFu));
}
// :435-447 UpdateInterrupts — IR_INT (bit 31) && IR_MASK (bit 28) of any of the four.
static void vi_update_irq(void) {
    int line = 0;
    for (uint32_t i = 0; i < 4; i++) {
        uint32_t r = vi_r32(0x30 + 4 * i);
        if ((r & 0x80000000u) && (r & 0x10000000u)) line = 1;
    }
    if (model(MODEL_IRQ)) pi_set(PI_CAUSE_VI, line);
}
static void vi_schedule(void) {
    uint32_t t = vi_ticks_per_half_line();
    g_vi_next = (model(MODEL_VI) && t) ? g_gk_cycles + t : UINT64_MAX;
}
// :905-1002 Update(), the parts that are not presentation: advance and wrap the counter,
// then raise IR_INT on a VCT/HCT match.  (BeginField/EndField present the XFB, and the SI
// poll at :950-969 is SI's — neither is modelled; both are named in README §10.6.)
static void vi_half_line(void) {
    uint32_t total = vi_half_lines_per_frame();
    if (++g_vi_hl >= total) { g_vi_hl = 0; g_vi_fields++; }
    uint32_t hlw = vi_r32(0x04) & 0x3FFu;
    for (uint32_t i = 0; i < 4; i++) {
        uint32_t r = vi_r32(0x30 + 4 * i);
        uint32_t hct = r & 0x7FFu, vct = (r >> 16) & 0x7FFu;
        uint32_t target = hct > hlw ? 1u : 0u;
        if (1u + g_vi_hl / 2u == vct && (g_vi_hl & 1u) == target) {
            dev_w16(VI_BASE + 0x30 + 4 * i, (r >> 16) | 0x8000u);
            g_model_events[MODEL_VI]++;
        }
    }
    vi_update_irq();
}
static void vi_preset(void) {        // VideoInterface.cpp:95-178, NTSC (SAB is GSNE8P)
    dev_w16(VI_BASE + 0x00, 0x0006);           // EQU 6, ACV 0
    dev_w16(VI_BASE + 0x02, 0x0001);           // ENB 1, FMT 0 (NTSC)
    dev_w32(VI_BASE + 0x04, 0x476901ADu);      // HLW 429, HCE 105, HCS 71
    dev_w32(VI_BASE + 0x08, 0x02EA5140u);      // HSY 64, HBE640 162, HBS640 373
    dev_w32(VI_BASE + 0x0C, 0x000501F6u);      // odd  PRB 502, PSB 5
    dev_w32(VI_BASE + 0x10, 0x000401F7u);      // even PRB 503, PSB 4
    dev_w32(VI_BASE + 0x14, 0x410C410Cu);      // burst odd  BS0 12 BE0 520 BS2 12 BE2 520
    dev_w32(VI_BASE + 0x18, 0x40ED40EDu);      // burst even BS0 13 BE0 519 BS2 13 BE2 519
    dev_w32(VI_BASE + 0x30, 0x110701AEu);      // DI0 HCT 430 VCT 263 MASK 1
    dev_w32(VI_BASE + 0x34, 0x10010001u);      // DI1 HCT 1   VCT 1   MASK 1
    dev_w16(VI_BASE + 0x6C, 0x0001);           // m_clock = IsNTSC(region) = 54 MHz
    g_vi_hl = 0;
    vi_schedule();
}

// ------------------------------------------------------------------------ AI (id 6)
#define AI_CR_EA   0xCC006C00u
#define AI_CNT_EA  0xCC006C08u
#define AI_IT_EA   0xCC006C0Cu
#define PI_CAUSE_AI 0x00000020u
#define AICR_PSTAT 0x01u
#define AICR_AISFR 0x02u
#define AICR_MSK   0x04u
#define AICR_INT   0x08u
#define AICR_VLD   0x10u
#define AICR_SCRST 0x20u
#define AICR_AIDFR 0x40u
// AudioInterface.cpp Init (:193-204): control 0, then SetAISSampleRate(48k) sets AISFR=1 and
// SetAIDSampleRate(32k) sets AIDFR=1 — so the register powers on as 0x42.
static uint32_t g_ai_ctrl = AICR_AISFR | AICR_AIDFR;
static uint32_t g_ai_count = 0, g_ai_it = 0;
static uint64_t g_ai_last = 0, g_ai_next = UINT64_MAX;
// m_cpu_cycles_per_sample = 486e6 * divisor / 108e6 (:187-189); divisor 2248 at 48 kHz and
// 3372 at "32 kHz" on GC (:348-356).
static uint64_t ai_cps(void) { return (g_ai_ctrl & AICR_AISFR) ? 10116u : 15174u; }
static void ai_update_irq(void) {                            // :96-100
    if (model(MODEL_IRQ)) pi_set(PI_CAUSE_AI, (g_ai_ctrl & AICR_INT) && (g_ai_ctrl & AICR_MSK));
}
static void ai_increase(uint32_t amount) {                   // :108-123 IncreaseSampleCount
    if (!(g_ai_ctrl & AICR_PSTAT)) return;
    uint32_t old = g_ai_count + 1u;
    g_ai_count += amount;
    if ((uint32_t)(g_ai_it - old) <= (uint32_t)(g_ai_count - old)) {
        g_ai_ctrl |= AICR_INT; g_model_events[MODEL_AI]++;
        ai_update_irq();
    }
}
static uint64_t ai_period(void) {                            // :125-133 GetAIPeriod
    uint64_t period = ai_cps() * (uint32_t)(g_ai_it - g_ai_count);
    uint64_t s_period = ai_cps() * 108000000u / ((g_ai_ctrl & AICR_AISFR) ? 2248u : 3372u);
    return period == 0 ? s_period : (period < s_period ? period : s_period);
}
static void ai_schedule(void) { g_ai_next = g_gk_cycles + ai_period(); }
static void ai_event(void) {                                 // :140-155 Update
    g_ai_next = UINT64_MAX;
    if (!(g_ai_ctrl & AICR_PSTAT)) return;
    uint64_t diff = g_gk_cycles - g_ai_last;
    if (diff > ai_cps()) {
        uint32_t samples = (uint32_t)(diff / ai_cps());
        g_ai_last += (uint64_t)samples * ai_cps();
        ai_increase(samples);
    }
    ai_schedule();
}
static uint32_t ai_count_read(void) {                        // :289-296, INCLUDING its quirk:
    // a STOPPED counter reads back sample_counter + m_last_cpu_time / cps.  That is the
    // reference's behaviour as written and it is transcribed, not corrected.
    uint64_t streamed = (g_ai_ctrl & AICR_PSTAT) ? (g_gk_cycles - g_ai_last) : g_ai_last;
    return g_ai_count + (uint32_t)(streamed / ai_cps());
}
static void ai_cr_write(uint32_t v) {                        // :213-277
    uint32_t c = g_ai_ctrl;
    c = (c & ~(AICR_MSK | AICR_VLD)) | (v & (AICR_MSK | AICR_VLD));
    c = (c & ~(AICR_AISFR | AICR_AIDFR)) | (v & (AICR_AISFR | AICR_AIDFR));
    if ((v & AICR_PSTAT) != (g_ai_ctrl & AICR_PSTAT)) {
        c = (c & ~AICR_PSTAT) | (v & AICR_PSTAT);
        g_ai_ctrl = c;
        g_ai_last = g_gk_cycles;
        ai_schedule();
    }
    if (v & AICR_INT)   c &= ~AICR_INT;
    if (v & AICR_SCRST) { g_ai_count = 0; g_ai_last = g_gk_cycles; }
    g_ai_ctrl = c;
    ai_update_irq();
}

// ------------------------------------------------------------------------ AID (id 8)
#define AID_START_HI 0xCC005030u
#define AID_START_LO 0xCC005032u
#define AID_CTRL     0xCC005036u
#define AID_LEFT     0xCC00503Au
static uint32_t g_aid_cur = 0, g_aid_left = 0, g_aid_on = 0, g_aid_blocks = 0;
static uint64_t g_aid_next = UINT64_MAX, g_aid_irq_at = UINT64_MAX;
static uint32_t aid_src(void) {             // :200-203, :314-321 — HI keeps 0x03ff on GC
    return ((dev_r16(AID_START_HI) & 0x03FFu) << 16) | (dev_r16(AID_START_LO) & 0xFFE0u);
}
static uint64_t aid_period(void) {          // SystemTimers.cpp:78-83
    return (uint64_t)486000000u * ((g_ai_ctrl & AICR_AIDFR) ? 3372u : 2248u) / 13500000u;
}
static void aid_gen_int(void) {             // GenerateDSPInterrupt(INT_AID)
    g_dsp_ctrl |= DSPC_AID; dev_w16(DSP_CONTROL_EA, g_dsp_ctrl);
    g_model_events[MODEL_AID]++;
    irq_update();
}
static void aid_reset(void) {
    if (!model(MODEL_AID)) return;
    dev_w16(AID_CTRL, 0); g_aid_on = 0;
}
static void aid_update(void) {              // DSP.cpp:424-454 UpdateAudioDMA
    uint32_t ctl = dev_r16(AID_CTRL);
    if (!(ctl & 0x8000u)) return;           // disabled: Dolphin sends 8 zero samples
    g_aid_blocks++;                         // (the 32 bytes at g_aid_cur would go to the mixer)
    if (g_aid_left != 0) { g_aid_left--; g_aid_cur += 32u; }
    if (g_aid_left == 0) {
        g_aid_cur = aid_src();
        g_aid_left = ctl & 0x7FFFu;
        aid_gen_int();
    }
}

// ------------------------------------------------------------------------ DI (id 10)
#define DI_BASE   0xCC006000u
#define PI_CAUSE_DI 0x00000004u
#define SR_F_DI       0xC6E00000u   // a DI command/sub-command/width this model does not cover
#define SR_F_DI_DISC  0xC6E10000u   // a read with no disc backend, or a failed host read
static FILE    *g_disc = 0;
static uint64_t g_disc_size = 0;
static uint32_t g_di_state = 1;        // DriveState::ReadyNoReadsMade (Boot.cpp:366)
static uint32_t g_di_error = 0;
static uint64_t g_di_done_at = UINT64_MAX;
static uint32_t g_di_done_int = 0;     // 2 = DEINT, 4 = TCINT (the DISR bit)
static uint32_t g_di_cmds = 0, g_di_bytes = 0;
static uint32_t g_di_disr = 0, g_di_dicvr = 0;   // the device's copies (w1c bits, read-only CVR)
static uint32_t g_di_log[64 * 6];
EMSCRIPTEN_KEEPALIVE uint32_t *sr_image_di_log(void) { return g_di_log; }
EMSCRIPTEN_KEEPALIVE int sr_image_set_disc(const char *path) {
    if (g_disc) fclose(g_disc);
    g_disc = fopen(path, "rb");
    if (!g_disc) return 0;
    fseeko(g_disc, 0, SEEK_END); g_disc_size = (uint64_t)ftello(g_disc);
    return 1;
}
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_di_cmds(void)  { return g_di_cmds; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_di_bytes(void) { return g_di_bytes; }
static uint32_t di_r(uint32_t o) { return dev_r32(DI_BASE + o); }
static void     di_w(uint32_t o, uint32_t v) { dev_w32(DI_BASE + o, v); }
static void di_update_irq(void) {                          // :633-643 UpdateInterrupts
    uint32_t sr = g_di_disr, cv = g_di_dicvr;
    int on = ((sr >> 2) & (sr >> 1) & 1) || ((sr >> 4) & (sr >> 3) & 1) ||
             ((sr >> 6) & (sr >> 5) & 1) || ((cv >> 2) & (cv >> 1) & 1);
    if (model(MODEL_IRQ)) pi_set(PI_CAUSE_DI, on);
}
// :705-739 CheckReadPreconditions — the disc is always inside and the cover closed here.
static int di_read_ok(void) {
    if (g_di_state == 3) { g_di_error = 0x62800; return 0; }                             // DiscChangeDetected: MediumChanged
    if (g_di_state == 5) { g_di_error = 0x20400; return 0; }                             // MotorStopped
    if (g_di_state == 6) { g_di_error = 0x20401; return 0; }                             // DiscIdNotRead
    return 1;
}
static int di_read(uint64_t off, uint32_t mar, uint32_t len, uint32_t outlen) {   // :742-779
    if (!di_read_ok()) return 2;
    if (len > outlen) len = outlen;
    if (off + len > g_disc_size) { g_di_error = 0x52100; return 2; }                // BlockOOB
    if (!g_disc) { if (!g_fault) g_fault = SR_F_DI_DISC | 1u; return 4; }
    uint32_t p = mar & 0x03FFFFFFu;
    if (p + len > g_ram_size) { if (!g_fault) g_fault = SR_F_DI_DISC | 2u; return 4; }
    if (fseeko(g_disc, (off_t)off, SEEK_SET) != 0 || fread(g_ram + p, 1, len, g_disc) != len) {
        if (!g_fault) g_fault = SR_F_DI_DISC | 3u; return 4;
    }
    g_di_bytes += len;
    return 4;
}
static void di_execute(void) {                             // :783-1213 ExecuteCommand
    uint32_t c0 = di_r(0x08), c1 = di_r(0x0C), c2 = di_r(0x10);
    uint32_t mar = di_r(0x14), len = di_r(0x18);
    uint32_t cmd = c0 >> 24, it = 4;                       // TCINT unless an error says DEINT
    if (g_di_cmds < 64) {                                  // the first 64 commands, for the report
        uint32_t *r = &g_di_log[g_di_cmds * 6];
        r[0] = c0; r[1] = c1; r[2] = c2; r[3] = mar; r[4] = len; r[5] = (uint32_t)(g_gk_cycles / 1000u);
    }
    g_di_cmds++;
    if (cmd != 0xE0) g_di_error = 0;
    switch (cmd) {
    case 0x12:                                             // Inquiry
        if (mar + 12u > g_ram_size) { if (!g_fault) g_fault = SR_F_DI | 0x12u; return; }
        gk_w32(0x80000000u | mar, 0x00000002u); gk_w32(0x80000000u | (mar + 4), 0x20060526u);
        gk_w32(0x80000000u | (mar + 8), 0x41000000u);
        break;
    case 0xA8:
        if ((c0 & 0xFF) == 0x00) {                         // Read sector
            if (g_di_state == 1) g_di_state = 0;
            it = (uint32_t)di_read((uint64_t)c1 << 2, mar, c2, len);
        } else if ((c0 & 0xFF) == 0x40) {                  // Read disc ID
            if (g_di_state == 6) g_di_state = 1; else if (g_di_state == 1) g_di_state = 0;
            it = (uint32_t)di_read(0, mar, 0x20, len);
        } else { if (!g_fault) g_fault = SR_F_DI | (c0 & 0xFFFFu); return; }
        break;
    case 0xAB: break;                                      // Seek: "Currently unimplemented"
    case 0xE0: {                                           // RequestError
        uint32_t ds = g_di_state == 0 ? 0 : g_di_state - 1;
        di_w(0x20, (ds << 24) | g_di_error);
        g_di_error = 0;
        break;
    }
    case 0xE3:                                             // StopMotor
        if (g_di_state == 0 || g_di_state == 1 || g_di_state == 6) g_di_state = 5;
        if (c0 & (1u << 17)) { if (!g_fault) g_fault = SR_F_DI | 0xE3u; return; }   // eject
        break;
    case 0xE4:                                             // AudioBufferConfig
        if (!di_read_ok()) { it = 2; break; }
        if (g_di_state == 0) { g_di_error = 0x52402; it = 2; break; }              // InvalidPeriod
        break;                                             // (DTK enable recorded nowhere: no DTK)
    default:
        if (!g_fault) g_fault = SR_F_DI | ((cmd << 8) & 0xFF00u); return;
    }
    g_di_done_at = g_gk_cycles + 300u * 486u;              // MINIMUM_COMMAND_LATENCY_US
    g_di_done_int = it;
    ev_rearm();
}
static void di_finish(void) {                              // :1307-1348, ReplyType::Interrupt
    g_di_done_at = UINT64_MAX;
    uint32_t cr = di_r(0x1C);
    if (g_di_done_int == 4) {
        uint32_t len = di_r(0x18);
        di_w(0x14, di_r(0x14) + len);
        di_w(0x18, 0);
    }
    if (cr & 1u) {
        di_w(0x1C, cr & ~1u);
        g_di_disr |= g_di_done_int; di_w(0x00, g_di_disr); // DEINT = bit 2, TCINT = bit 4
        g_model_events[MODEL_DI]++;
        di_update_irq();
    }
}

// ------------------------------------------------------------- device read / write
static void dev_read_models(uint32_t ea, uint32_t n) {
    if (model(MODEL_AR) && dev_hits(ea, n, 0xCC005016u, 2)) dev_w16(0xCC005016u, 1);
    if (model(MODEL_PIREV) && dev_hits(ea, n, PI_REV_EA, 4)) dev_w32(PI_REV_EA, 0x246500B1u);
    if (model(MODEL_IRQ) && dev_hits(ea, n, PI_INTSR_EA, 4)) dev_w32(PI_INTSR_EA, g_pi_cause);
    if (model(MODEL_DI)) {
        if (dev_hits(ea, n, DI_BASE + 0x00, 4)) di_w(0x00, g_di_disr);
        if (dev_hits(ea, n, DI_BASE + 0x04, 4)) di_w(0x04, g_di_dicvr);
        if (dev_hits(ea, n, DI_BASE + 0x24, 4)) di_w(0x24, 1u);      // DICFG.CONFIG = 1 (:276-277)
    }
    if (model(MODEL_AID) && dev_hits(ea, n, AID_LEFT, 2))              // :352-361
        dev_w16(AID_LEFT, g_aid_left > 0 ? g_aid_left - 1u : 0u);
    if (model(MODEL_AI)) {
        if (dev_hits(ea, n, AI_CR_EA, 4))  dev_w32(AI_CR_EA, g_ai_ctrl);
        if (dev_hits(ea, n, AI_CNT_EA, 4)) dev_w32(AI_CNT_EA, ai_count_read());
        if (dev_hits(ea, n, AI_IT_EA, 4))  dev_w32(AI_IT_EA, g_ai_it);
    }
    if (model(MODEL_VI)) {
        // VideoInterface.cpp:317-334: vertical = 1 + hl/2; horizontal from the tick offset
        // into the current line.  The horizontal position needs m_ticks_last_line_start,
        // which this model does not keep — a read of it RAISES rather than returning a guess.
        if (dev_hits(ea, n, VI_BASE + 0x2C, 2)) dev_w16(VI_BASE + 0x2C, 1u + g_vi_hl / 2u);
        if (dev_hits(ea, n, VI_BASE + 0x2E, 2) && !g_fault) g_fault = SR_F_IMG_UNIMPL | 0xCC202Eu;
    }
}
static void dev_write_models(uint32_t ea, uint32_t n) {
    if (model(MODEL_UCODE) && g_dsp_model && dev_hits(ea, n, 0xCC005002u, 2)) {
        // DSPHLE.cpp:179-190: the LOW half sends; then "clear MSB to show that it is progressed".
        uint32_t mail = dev_r32(0xCC005000u);
        ucode_mail(mail);
        dev_w16(0xCC005000u, (mail >> 16) & 0x7FFFu);
        if (g_fault) ev_rearm();              // a ucode wall: let strict stop at the next block
    }
    if (model(MODEL_AR)) {
        if (dev_hits(ea, n, 0xCC005016u, 2)) dev_w16(0xCC005016u, 1);              // WMASK_NONE
        if (dev_hits(ea, n, 0xCC00501Au, 2)) dev_w16(0xCC00501Au, dev_r16(0xCC00501Au) & 0x07FFu);
    }
    if (model(MODEL_IRQ)) {
        if (dev_hits(ea, n, PI_INTSR_EA, 4) || dev_hits(ea, n, PI_INTMR_EA, 4)) {
            if (n != 4 || (ea != PI_INTSR_EA && ea != PI_INTMR_EA)) {
                if (!g_fault) g_fault = SR_F_PI_WIDTH | (ea & 0xFFFFu);
            } else if (ea == PI_INTSR_EA) {                // ProcessorInterface.cpp:71-75
                g_pi_cause &= ~dev_r32(PI_INTSR_EA);
                dev_w32(PI_INTSR_EA, g_pi_cause);
                pi_update();
            } else {                                       // :77-82
                g_pi_mask = dev_r32(PI_INTMR_EA);
                pi_update();
            }
        }
    }
    if (model(MODEL_DI) && ea >= DI_BASE && ea < DI_BASE + 0x40u) {
        uint32_t o = ea - DI_BASE;
        if (n != 4 || (o & 3u)) { if (!g_fault) g_fault = SR_F_DI | 0xFFFFu; }
        else if (o == 0x00) {                              // :550-575 DISR
            uint32_t v = di_r(0x00), old = g_di_disr;
            // masks (bits 1,3,5) and BREAK (bit 0) take the written value; DEINT/TCINT/BRKINT
            // (bits 2,4,6) are write-1-to-clear.
            uint32_t nv = (v & 0x2Bu) | (old & 0x54u & ~v);
            if (nv & 1u) { if (!g_fault) g_fault = SR_F_DI | 0xB0u; }   // BREAK: DEBUG_ASSERT
            g_di_disr = nv; di_w(0x00, nv); di_update_irq();
        } else if (o == 0x04) {                            // :577-587 DICVR
            uint32_t v = di_r(0x04), old = g_di_dicvr;
            uint32_t nv = (old & ~0x2u) | (v & 0x2u);
            if (v & 0x4u) nv &= ~0x4u;
            g_di_dicvr = nv; di_w(0x04, nv); di_update_irq();
        } else if (o == 0x14) di_w(0x14, di_r(0x14) & ~0xFC00001Fu);   // :611-612 GC mask
        else if (o == 0x18) di_w(0x18, di_r(0x18) & ~0x1Fu);           // :613-614
        else if (o == 0x1C) {                              // :615-623 DICR
            uint32_t v = di_r(0x1C) & 7u;
            di_w(0x1C, v);
            if (v & 1u) di_execute();
        } else if (o == 0x24) di_w(0x24, 1u);             // read-only (InvalidWrite): keep it
    }
    if (model(MODEL_AID)) {
        if (dev_hits(ea, n, AID_START_HI, 2)) dev_w16(AID_START_HI, dev_r16(AID_START_HI) & 0x03FFu);
        if (dev_hits(ea, n, AID_START_LO, 2)) dev_w16(AID_START_LO, dev_r16(AID_START_LO) & 0xFFE0u);
        if (dev_hits(ea, n, AID_CTRL, 2)) {                              // :322-347
            uint32_t ctl = dev_r16(AID_CTRL);
            if (!g_aid_on && (ctl & 0x8000u)) {
                g_aid_cur = aid_src(); g_aid_left = ctl & 0x7FFFu;
                g_aid_irq_at = g_gk_cycles + 200u;
            }
            g_aid_on = (ctl & 0x8000u) != 0;
            if (g_aid_next == UINT64_MAX) g_aid_next = g_gk_cycles + aid_period();
            ev_rearm();
        }
    }
    if (model(MODEL_AI) && ea >= AI_CR_EA && ea < AI_CR_EA + 0x10u) {
        // All four AI registers are registered 32-bit only (AudioInterface.cpp:213-315).
        if (n != 4 || (ea & 3u)) { if (!g_fault) g_fault = SR_F_PI_WIDTH | (ea & 0xFFFFu); }
        else if (ea == AI_CR_EA)  ai_cr_write(dev_r32(AI_CR_EA));
        else if (ea == AI_CNT_EA) { g_ai_count = dev_r32(AI_CNT_EA); g_ai_last = g_gk_cycles; ai_schedule(); }
        else if (ea == AI_IT_EA)  { g_ai_it = dev_r32(AI_IT_EA); ai_schedule(); }
        ev_rearm();
    }
    if (model(MODEL_VI) && ea >= VI_BASE && ea < VI_BASE + 0x80u) {
        // A write to any DI HI half re-evaluates the line (:343-369).  Clearing IR_INT is
        // what the guest's handler does (dolsdk2001 src/vi/vi.c:164-181).
        for (uint32_t i = 0; i < 4; i++)
            if (dev_hits(ea, n, VI_BASE + 0x30 + 4 * i, 2)) vi_update_irq();
        if (dev_hits(ea, n, VI_BASE + 0x02, 2) && (dev_r16(VI_BASE + 0x02) & 2u)) {
            // :392-417: RST clears every interrupt register and the RST bit itself.
            for (uint32_t i = 0; i < 4; i++) dev_w32(VI_BASE + 0x30 + 4 * i, 0);
            dev_w16(VI_BASE + 0x02, dev_r16(VI_BASE + 0x02) & ~2u);
            vi_update_irq();
        }
        // A timing register change takes effect at the next half line, as in Dolphin, where
        // UpdateParameters only changes the period CoreTiming uses from then on.
        if (g_vi_next == UINT64_MAX) vi_schedule();
    }
}

// ------------------------------------------------------------------- DELIVERY
// THE ONE PLACE A GUEST EXCEPTION IS ENTERED.  Called from gk_event() at a basic-block head
// (gekko_rt.h), where every guest register is in *st.
//
// What hardware + DOLSDK do, and what this does for each step:
//   CPU (PowerPC.cpp:583-632)  SRR1 = MSR & 0x87C0FFFF; MSR &= ~0x04EF36; jump to the vector.
//                              External beats decrementer (:590 before :617).  Done here.
//   __OSEVStart (OS.c:348-420) r4 = *(0xC0) (physical context); store r3,r4,r5; state |= EXC;
//                              store CR LR CTR XER SRR0 SRR1; check SRR1[RI]; r3 = exception;
//                              r4 = *(0xD4) (virtual context); jump to OSExceptionTable[exc]
//                              (0x80003000).  Done here, reading the table the guest's own
//                              OSInit filled.  RI clear RAISES instead of running
//                              OSDefaultExceptionHandler.
//   2nd-level handler          ExternalInterruptHandler / DecrementerExceptionHandler are
//                              OS_EXCEPTION_SAVE_GPRS (dolsdk2001 include/dolphin/os/
//                              OSException.h:35-53) then `b <dispatcher>`.  They contain mfspr
//                              GQRn, which the translator refuses, so their 18 words are
//                              CHECKED against that template (any mismatch raises), performed,
//                              and the branch target is DECODED from the 19th word.
//   dispatcher                 __OSDispatchInterrupt / DecrementerExceptionCallback RUN
//                              TRANSLATED, on the interrupted stack, as on hardware.
//   OSLoadContext(context)     the dispatcher's last act; never returns.  img_host() below
//                              longjmps back here when it sees it for THIS context, and the
//                              registers are loaded by sr_host_os.c's ctx_load — the same
//                              transcription (RAS fixup included) the context tier uses.
// ⚠ NOT MODELLED, stated: SRR0.  sr.py keeps no program counter, so the saved SRR0 is written
// as 0.  Only code that inspects a saved context's SRR0 could see it; OSLoadContext's RAS
// fixup (0x800e78ac..0x800e78bc) is the one reader on this path, and 0 is outside that range.
// FPRs are SNAPSHOTTED and restored around the handler: DOLSDK saves them lazily through the
// FP-unavailable exception (MSR[FP] is cleared by the entry above) and this runtime does not
// raise that exception, so a handler that uses the FPU must not be able to clobber the
// interrupted thread's registers.
static uint32_t g_irq_delivered = 0, g_irq_last = 0;
static uint32_t g_dec_delivered = 0;
// PER HOST THREAD.  Under SR_OS_HLE each guest thread runs on its own host thread, and a
// thread preempted inside an exception is PARKED inside that exception's delivery frame on
// its own stack — so "which delivery is live" is a property of the host thread.
// A STACK, not one slot: an exception can be entered while a handler runs (a handler that
// re-enables interrupts), and the inner delivery must not overwrite the outer one's jmp_buf —
// measured: with one slot the outer handler's OSLoadContext longjmp'd into the inner, already
// returned frame and `throw Infinity` (emscripten's longjmp) escaped the module.
#define IRQ_NEST 8
static _Thread_local uint32_t g_irq_depth = 0, g_irq_ctx = 0;
static _Thread_local uint32_t g_irq_ctxs[IRQ_NEST];
static _Thread_local jmp_buf  g_irq_jmps[IRQ_NEST];
#define SR_F_IRQ_NEST 0xC6B70000u
static const uint32_t SAVE_GPRS_TEMPLATE[18] = {
    0x90040000u, 0x90240004u, 0x90440008u, 0xBCC40018u,
    0x7C11E2A6u, 0x900401A8u, 0x7C12E2A6u, 0x900401ACu, 0x7C13E2A6u, 0x900401B0u,
    0x7C14E2A6u, 0x900401B4u, 0x7C15E2A6u, 0x900401B8u, 0x7C16E2A6u, 0x900401BCu,
    0x7C17E2A6u, 0x900401C0u };

static int irq_enter(GekkoState *st, uint32_t exc) {
    uint32_t msr = sr_os_get_msr();
    uint32_t handler = gk_r32(0x80003000u + 4u * exc);
    for (int i = 0; i < 18; i++)
        if (gk_r32(handler + 4u * (uint32_t)i) != SAVE_GPRS_TEMPLATE[i]) {
            if (!g_fault) g_fault = SR_F_IRQ_HANDLER | (handler & 0xFFFFu);
            return 0;
        }
    uint32_t b = gk_r32(handler + 72u);
    if ((b & 0xFC000003u) != 0x48000000u) { if (!g_fault) g_fault = SR_F_IRQ_HANDLER | 0xFFFFu; return 0; }
    uint32_t disp = handler + 72u + (uint32_t)(((int32_t)(b << 6)) >> 6 & ~3);

    uint32_t srr1 = msr & 0x87C0FFFFu;
    if (!(srr1 & 0x2u)) { if (!g_fault) g_fault = SR_F_IRQ_UNRECOV | (exc & 0xFFFFu); return 0; }
    uint32_t pctx = 0x80000000u | gk_r32(0x800000C0u);   // OS_CURRENTCONTEXT_PADDR
    uint32_t vctx = gk_r32(0x800000D4u);
    // __OSEVStart
    gk_w32(pctx + OSCTX_GPR(3), st->gpr[3]);
    gk_w32(pctx + OSCTX_GPR(4), st->gpr[4]);
    gk_w32(pctx + OSCTX_GPR(5), st->gpr[5]);
    gk_w16(pctx + OSCTX_STATE, (uint16_t)(gk_r16(pctx + OSCTX_STATE) | OSCTX_STATE_EXC));
    gk_w32(pctx + OSCTX_CR, st->cr);   gk_w32(pctx + OSCTX_LR, st->lr);
    gk_w32(pctx + OSCTX_CTR, st->ctr); gk_w32(pctx + OSCTX_XER, st->xer);
    gk_w32(pctx + OSCTX_SRR0, 0);      gk_w32(pctx + OSCTX_SRR1, srr1);
    // OS_EXCEPTION_SAVE_GPRS(r4 = virtual context)
    gk_w32(vctx + OSCTX_GPR(0), st->gpr[0]);
    gk_w32(vctx + OSCTX_GPR(1), st->gpr[1]);
    gk_w32(vctx + OSCTX_GPR(2), st->gpr[2]);
    for (int r = 6; r < 32; r++) gk_w32(vctx + OSCTX_GPR(r), st->gpr[r]);
    for (int q = 1; q < 8; q++)  gk_w32(vctx + OSCTX_GQR(q), st->gqr[q]);

    uint64_t fsave0[32], fsave1[32]; uint32_t fpscr = st->fpscr;
    memcpy(fsave0, st->ps0, sizeof fsave0); memcpy(fsave1, st->ps1, sizeof fsave1);

    sr_os_set_msr((msr & ~0x04EF36u) | 0x30u);     // exception entry, then __OSEVStart's rfi
    st->gpr[3] = exc; st->gpr[4] = vctx; st->gpr[5] = handler;
    if (g_irq_depth >= IRQ_NEST) { if (!g_fault) g_fault = SR_F_IRQ_NEST | exc; return 0; }
    uint32_t saved_depth_ctx = g_irq_ctx, my = g_irq_depth;
    g_irq_ctxs[my] = vctx;
    g_irq_depth++; g_irq_ctx = vctx; g_irq_last = exc;
    tail_mark(0x10 | exc, vctx);                    // 0xEEEE0014 external / 0xEEEE0018 dec
    int loaded = setjmp(g_irq_jmps[my]);
    if (!loaded) {
        if (!sr_dispatch(disp, st)) { if (!g_fault) g_fault = SR_F_IRQ_NOTRANS | (disp & 0xFFFFu); }
        else if (!g_fault) g_fault = SR_F_IRQ_NOLOAD | (disp & 0xFFFFu);
        g_irq_depth--; g_irq_ctx = saved_depth_ctx;
        return 0;
    }
    g_irq_depth--; g_irq_ctx = saved_depth_ctx;
    sr_os_ctx_load(st, vctx);                      // registers + MSR <- SRR1 (OSContext.c:281)
    tail_mark(0x20, vctx);                         // 0xEEEE0020 returned from the exception
    memcpy(st->ps0, fsave0, sizeof fsave0); memcpy(st->ps1, fsave1, sizeof fsave1);
    st->fpscr = fpscr;
    return 1;
}

// The handler's OSLoadContext for the context THIS layer entered with: never returns.
static int irq_load_context(GekkoState *st) {
    if (!g_irq_depth || st->gpr[3] != g_irq_ctx) return 0;
    longjmp(g_irq_jmps[g_irq_depth - 1], 1);
}

// sr_host_os.c's sr_irq_resume_hook: this host thread was switched away inside the
// exception it is now being resumed from — perform that exception's OSLoadContext.
static void irq_resume(GekkoState *st, uint32_t ctx) {
    (void)st;
    if (g_irq_depth && g_irq_ctx == ctx) longjmp(g_irq_jmps[g_irq_depth - 1], 1);
}

// sr_host_os.c's sr_idle_hook: the guest is in SelectThread's idle spin with MSR[EE] set.
// That loop retires cycles and does nothing else until an interrupt readies a thread, so
// guest time is advanced straight to the next scheduled device event — which is what
// Dolphin does with an idle loop (CoreTiming.cpp:574-588 Idle(): the remaining downcount is
// counted as idled cycles and the next event runs).  Returns 0 when nothing at all is
// scheduled: then no interrupt can ever arrive and the idle is a real deadlock.
static uint64_t g_idle_cycles = 0;
static uint32_t g_idle_skips = 0;
static int img_idle(void) {
    ev_rearm();       // EE was just set by a direct C call (os_enable_interrupts), not a crossing
    tail_mark(0x30, (uint32_t)(g_gk_event_at - g_gk_cycles));   // 0xEEEE0030 idle skip
    if (g_gk_event_at == UINT64_MAX) return 0;
    if (g_gk_event_at > g_gk_cycles) {
        g_idle_cycles += g_gk_event_at - g_gk_cycles;
        g_gk_cycles = g_gk_event_at;
    }
    g_idle_skips++;
    gk_event();
    return 1;
}
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_idle_skips(void)     { return g_idle_skips; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_idle_mcycles(void)   { return (uint32_t)(g_idle_cycles / 1000000u); }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_cycles_m(void)       { return (uint32_t)(g_gk_cycles / 1000000u); }

// THE GUEST-TIME BUDGET.  The device-read watchdog cannot see a guest that spins on MEMORY
// (a software flag an interrupt handler would set) — measured: the SRN_IRQ=0 arm ran 1,200 s
// of wall time with no output.  A budget in RETIRED GUEST CYCLES bounds every run by guest
// time instead, deterministically, and throws the same way the watchdog does.  0 = off.
static uint64_t g_budget = 0;
static uint32_t g_budget_hit = 0, g_budget_thread = 0;
static GekkoState g_budget_st;
static uint32_t g_bthr[16 * 6], g_bthr_n = 0, g_bthr_bits = 0;
EMSCRIPTEN_KEEPALIVE uint32_t *sr_image_budget_threads(void)   { return g_bthr; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_budget_threads_n(void) { return g_bthr_n; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_budget_runq(void)      { return g_bthr_bits; }
EMSCRIPTEN_KEEPALIVE uint32_t    sr_image_budget_thread(void) { return g_budget_thread; }
EMSCRIPTEN_KEEPALIVE GekkoState *sr_image_budget_state(void)  { return &g_budget_st; }
EMSCRIPTEN_KEEPALIVE void sr_image_set_budget_mcycles(uint32_t m) { g_budget = (uint64_t)m * 1000000u; }

// THE EXPLORATORY ARM.  By default no exception is entered once g_fault is set: a faulted
// guest is not the machine any more.  sr_image_set_past_fault(1) delivers anyway, so ONE run
// can show what the boot would reach NEXT if the first wall were modelled.  Everything such a
// run reports after its first fault is exploratory and must be quoted as such (README §10.6).
static uint32_t g_past_fault = 0;
EMSCRIPTEN_KEEPALIVE void sr_image_set_past_fault(uint32_t on) { g_past_fault = on; }

uint64_t g_gk_event_at = 0;     // 0: the first block head evaluates everything once
static void ev_rearm(void) {
    uint64_t at = g_budget ? g_budget : UINT64_MAX;
    if (model(MODEL_IRQ)) {
        uint64_t d = sr_dec_due_at();
        if (d < at) at = d;
        if ((sr_os_get_msr() & 0x8000u) && (g_ext_pending || g_dec_pending)) at = 0;
    }
    if (model(MODEL_VI) && g_vi_next < at) at = g_vi_next;
    if (model(MODEL_AI) && g_ai_next < at) at = g_ai_next;
    if (model(MODEL_AID) && g_aid_next < at) at = g_aid_next;
    if (model(MODEL_AID) && g_aid_irq_at < at) at = g_aid_irq_at;
    if (g_dsp_int_at < at) at = g_dsp_int_at;
    if (model(MODEL_DI) && g_di_done_at < at) at = g_di_done_at;
    if (g_strict && g_fault) at = 0;          // strict: the next block head ends the run
    g_gk_event_at = at;
}

void gk_event(void) {
    GekkoState *st = sr_state();
    // STRICT MEANS THE FIRST FAULT OF ANY KIND ENDS THE RUN — not only an unimplemented host
    // boundary (img_hook), but a device or ucode wall raised inside a model (SR_F_DSP_AXCMD,
    // SR_F_IRQ_*, ...), which sets g_fault and returns.  The next block head is the stop.
    if (g_strict && g_fault)
        EM_ASM({ throw new Error('sr_image strict: fault 0x' + ($0 >>> 0).toString(16)); }, g_fault);
    if (g_budget && g_gk_cycles >= g_budget) {
        if (!g_budget_hit) {            // the thread that was RUNNING when time ran out
            g_budget_hit = 1; g_budget_thread = gk_r32(0x800000E4u); g_budget_st = *st;
            // ...and every guest thread AT THAT INSTANT (__OSActiveThreadQueue at 0x800000DC,
            // linkActive at +0x2FC), because what the hand-off to slot 0 below does next is
            // not part of the measurement.
            uint32_t t = gk_r32(0x800000DCu);
            for (g_bthr_n = 0; t && g_bthr_n < 16; t = gk_r32(t + 0x2FCu), g_bthr_n++) {
                uint32_t *r = &g_bthr[g_bthr_n * 6];
                r[0] = t; r[1] = gk_r16(t + 0x2C8u); r[2] = gk_r32(t + 0x2D0u);
                r[3] = gk_r32(t + 0x198u); r[4] = gk_r32(t + 0x84u); r[5] = gk_r32(t + 4u);
            }
            g_bthr_bits = gk_r32(st->gpr[13] + (uint32_t)-30176);   // RunQueueBits (SDA -30176)
        }
        if (!g_fault) g_fault = 0xC6BF0000u;
#ifdef __EMSCRIPTEN_PTHREADS__
        sr_os_budget_yield();           // a pool thread does not return from this
#endif
        EM_ASM({ throw new Error('sr_image budget: ' + $0 + ' M guest cycles retired'); },
               (uint32_t)(g_gk_cycles / 1000000u));
    }
    if (model(MODEL_VI)) {
        if (g_vi_next == UINT64_MAX) vi_schedule();
        while (g_vi_next <= g_gk_cycles) {
            uint64_t due = g_vi_next;
            vi_half_line();
            uint32_t t = vi_ticks_per_half_line();
            g_vi_next = t ? due + t : UINT64_MAX;
        }
    }
    if (g_dsp_int_at <= g_gk_cycles) { g_dsp_int_at = UINT64_MAX; dsp_gen_int(); }
    if (model(MODEL_DI) && g_di_done_at <= g_gk_cycles) di_finish();
    if (model(MODEL_AI) && g_ai_next <= g_gk_cycles) ai_event();
    if (model(MODEL_AID)) {
        if (g_aid_irq_at <= g_gk_cycles) { g_aid_irq_at = UINT64_MAX; aid_gen_int(); }
        while (g_aid_next <= g_gk_cycles) { uint64_t due = g_aid_next; aid_update(); g_aid_next = due + aid_period(); }
    }
    if (model(MODEL_IRQ)) {
        if (sr_dec_take()) g_dec_pending = 1;
        if ((!g_fault || g_past_fault) && (sr_os_get_msr() & 0x8000u)) {
            // PowerPC.cpp:590 before :617 — external first.
            if (g_ext_pending) {
                g_ext_pending = 0;
                if (irq_enter(st, 4)) { g_irq_delivered++; g_model_events[MODEL_IRQ]++; }
            } else if (g_dec_pending) {
                g_dec_pending = 0;
                if (irq_enter(st, 8)) { g_dec_delivered++; g_model_events[MODEL_IRQ]++; }
            }
        }
    }
    ev_rearm();
}
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_irq_delivered(void) { return g_irq_delivered; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_dec_delivered(void) { return g_dec_delivered; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_irq_last(void)      { return g_irq_last; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_pi_cause(void)      { return g_pi_cause; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_pi_mask(void)       { return g_pi_mask; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_vi_frames(void)     { return g_vi_fields; }

// ------------------------------------------------------------------- REAL MODE (id 2)
// Interpret RealMode (0x800e8a4c) and the function it `rfi`s into, from the shipped words.
static int img_realmode(GekkoState *st) {
    uint32_t pc = 0x800e8a4cu, srr0 = 0, srr1 = 0, ret = st->lr;
    for (int step = 0; step < 256; step++) {
        uint32_t w = gk_r32(pc), op = w >> 26;
        uint32_t rd = (w >> 21) & 31u, ra = (w >> 16) & 31u;
        uint32_t sprn = ((w >> 16) & 31u) | (((w >> 11) & 31u) << 5), xo = (w >> 1) & 0x3FFu;
        int32_t  si = (int16_t)(w & 0xFFFFu);
        if (op == 14)      st->gpr[rd] = (ra ? st->gpr[ra] : 0) + (uint32_t)si;          // addi
        else if (op == 15) st->gpr[rd] = (ra ? st->gpr[ra] : 0) + ((uint32_t)si << 16);  // addis
        else if (op == 24) st->gpr[ra] = st->gpr[rd] | (w & 0xFFFFu);                    // ori
        else if (op == 21 && !(w & 1u)) {                                               // rlwinm
            uint32_t sh = (w >> 11) & 31u, mb = (w >> 6) & 31u, me = (w >> 1) & 31u;
            st->gpr[ra] = gk_rotl32(st->gpr[rd], sh) & gk_mask(mb, me);
        }
        else if (w == 0x4C00012Cu) { }                                                   // isync
        else if (op == 31 && xo == 83)  st->gpr[rd] = sr_os_get_msr();                   // mfmsr
        else if (op == 31 && xo == 339 && sprn == 8) st->gpr[rd] = st->lr;               // mflr
        else if (op == 31 && xo == 467 && sprn == 26) srr0 = st->gpr[rd];                // mtsrr0
        else if (op == 31 && xo == 467 && sprn == 27) srr1 = st->gpr[rd];                // mtsrr1
        else if (op == 31 && xo == 467 && sprn >= 528 && sprn <= 543) g_spr[sprn] = st->gpr[rd]; // BATs
        else if (w == 0x4C000064u) {                                                     // rfi
            sr_os_set_msr(srr1);
            pc = srr0 | 0x80000000u;             // physical -> the flat MEM1 alias
            if (pc == ret) { g_model_events[MODEL_RM]++; return 1; }
            if (srr0 & 0x80000000u) { if (!g_fault) g_fault = SR_F_RM_RETURN | (srr0 & 0xFFFFu); return 1; }
            continue;
        }
        else { if (!g_fault) g_fault = SR_F_RM_OPCODE | (pc & 0xFFFFu); return 1; }
        pc += 4;
    }
    if (!g_fault) g_fault = SR_F_RM_RETURN | 0xFFFFu;
    return 1;
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

    // ---- [2026-09-29] 0x800e8a4c RealMode — see THE NEXT DEVICES, id 2.
    case 0x800e8a4cu:
        if (!model(MODEL_RM)) return 0;
        img_realmode(st);
        img_log(addr, IMG_D_REAL);
        return 1;
    // ---- [2026-09-29] 0x800e56bc OSLoadContext, for the context an exception was entered
    // with (THE NEXT DEVICES, id 3).  Any OTHER context falls through to sr_host_os.c, i.e.
    // a thread switch is still that layer's business and still refused outside SR_OS_HLE.
    case 0x800e56bcu:
        if (!model(MODEL_IRQ) || !g_irq_depth || st->gpr[3] != g_irq_ctx) return 0;
        img_log(addr, IMG_D_REAL);
        return irq_load_context(st);        // longjmps; does not return for our context

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

static int img_hook_inner(GekkoState *st, uint32_t addr);
// THE TAIL RING — [2026-09-29].  The boundary log keeps the FIRST 16,384 crossings, which is
// the right instrument for "how far did the boot get" and the wrong one for "what was it
// doing when it stopped" once a run is seconds of guest time long.  This keeps the LAST 64,
// each with the caller's LR, MSR after the crossing, and the current guest thread.
#define TAIL_N 64
static uint32_t g_tail[TAIL_N * 4];
static uint32_t g_tail_n = 0;
EMSCRIPTEN_KEEPALIVE uint32_t *sr_image_tail(void)   { return g_tail; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_image_tail_n(void) { return g_tail_n; }
// Non-crossing events share the ring: addr = 0xEEEE00kk, lr = the event's argument.
static void tail_mark(uint32_t kind, uint32_t a) {
    uint32_t i = (g_tail_n++ % TAIL_N) * 4u;
    g_tail[i] = 0xEEEE0000u | kind; g_tail[i + 1] = a; g_tail[i + 2] = sr_os_get_msr();
    g_tail[i + 3] = gk_r32(0x800000E4u);
}
static void tail_rec(GekkoState *st, uint32_t addr) {
    uint32_t i = (g_tail_n++ % TAIL_N) * 4u;
    g_tail[i] = addr; g_tail[i + 1] = st->lr; g_tail[i + 2] = sr_os_get_msr();
    g_tail[i + 3] = gk_r32(0x800000E4u);
}

static int img_hook(GekkoState *st, uint32_t addr) {
    int r = img_hook_inner(st, addr);
    tail_rec(st, addr);
    return r;
}
static int img_hook_inner(GekkoState *st, uint32_t addr) {
    if (img_host(st, addr)) return 1;
    if (sr_host_call(st, addr)) {
        img_log(addr, IMG_D_OS);
        // [2026-09-29] MSR[EE] can only change here (the --msr-audit containment: no emitted
        // body touches MSR), so this is where a pending interrupt becomes deliverable.  The
        // CPU takes it right after the mtmsr (PowerPC.cpp:588 checks EE on every exception
        // check); re-arming makes the very next block head — the instruction after this
        // call — take it.  Without this, measured: 3 deliveries in 10 s of guest time with
        // DSP|VI pending and unmasked, because EE was only ever on between two crossings.
        ev_rearm();
        return 1;
    }
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
    sr_idle_hook = img_idle;
    sr_irq_resume_hook = irq_resume;
    return 1;
}
// [2026-09-29] SR_OS_HLE for the whole image — §10.5 item 2.  Needs a -pthread link
// (build_image.sh SR_PTHREAD=1); creates the host thread pool (one host thread per guest
// thread, CONTEXT_SWITCH.md) and puts the image's hook back on top of it.
#ifdef __EMSCRIPTEN_PTHREADS__
EMSCRIPTEN_KEEPALIVE int sr_image_init_hle(int nthreads) {
    int n = sr_os_init(nthreads);
    sr_os_mode(SR_OS_HLE);
    sr_host_hook = img_hook;
    return n;
}
#endif

// Run the guest from the DOL entry point.  RETURNS ONLY WHEN THE GUEST RETURNS OR
// FAULTS — sr.py's output is straight-line C in which a guest `bl` is a host call, so
// there is no way to interrupt it from outside.  A guest that reaches its own main loop
// does not come back, which is why the caller must run this on a worker thread and read
// the boundary log from the main thread through the SAB rather than waiting on a
// return value.
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_boot(void) {
    if (!g_dol_loaded) return SR_F_IMG_NO_DOL;
    g_fault = 0;
    // [2026-09-29] power-on device state, applied HERE (not in sr_image_init) so the run-time
    // model switches set between init and boot decide it — each OFF arm boots with the
    // window exactly as the previous build left it (all zero).
    if (model(MODEL_AR)) { dev_w16(0xCC005016u, 1); dev_w16(0xCC00501Au, 156); }  // DSP.cpp:148-149
    if (model(MODEL_VI)) vi_preset();
    if (model(MODEL_AI)) dev_w32(AI_CR_EA, g_ai_ctrl);
    ev_rearm();
    return sr_call(g_dol_entry);
}

// Run ONE translated function by guest address, for bring-up: it makes "does __start's
// first callee work?" answerable without committing to a run that never returns.
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_call(uint32_t addr) {
    g_fault = 0;
    return sr_call(addr);
}

EMSCRIPTEN_KEEPALIVE uint32_t sr_image_fault(void) { return g_fault; }
extern uint32_t g_indirect_fault_lr, g_indirect_fault_target;   // sr_driver.c, -DSR_MMIO
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_indirect_fault_lr(void)     { return g_indirect_fault_lr; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_image_indirect_fault_target(void) { return g_indirect_fault_target; }
