// sr_host_os.h — the HOST OS BOUNDARY for the SAB static recompiler.
//
// WHAT THIS SOLVES.  A binary static recomp cannot use MP4's escape of never
// compiling OSThread.c in: SelectThread / OSSaveContext / OSLoadContext / rfi are
// all inside main.dol and all translate.  The blocker is that OSSaveContext is a
// setjmp — it RETURNS TWICE — and OSLoadContext is its longjmp, and sr.py's output
// is straight-line C where a guest call is a host call.  A host C function cannot
// return twice: its frame is gone the moment it returns the first time.  See
// CONTEXT_SWITCH.md §2 for the measured proof (a setjmp/longjmp spike throws
// `WebAssembly.Exception` out of the module under -sSUPPORT_LONGJMP=wasm, and
// `Infinity` under the emscripten default, because the jmp_buf's frame is dead).
//
// THE ANSWER: move the host boundary UP one level, to SelectThread — the single
// function that contains BOTH the save and the load.  Then the park point and the
// resume point are the same host C frame, one guest thread gets one host thread,
// and the switch is a semaphore hand-off with no stack switching at all.  This is
// N64Recomp's deletion (~/gc_refs/N64Recomp/README.md:32 "skip recompilation of
// specific functions"), applied at the smallest possible cut: ONE guest function.
//
// Everything above SelectThread stays TRANSLATED guest code operating on the real
// guest structures in MEM1 — OSCreateThread, OSResumeThread, OSSuspendThread,
// OSSleepThread, OSWakeupThread, OSJoinThread, OSExitThread, the mutexes, the
// message queues, __OSReschedule.  Nothing about the guest's thread state is
// reimplemented; the host only replaces the register save/restore + the hand-off.
#ifndef SR_HOST_OS_H
#define SR_HOST_OS_H

#include <stdint.h>
#include "gekko_rt.h"

// ---------------------------------------------------------------- modes
#define SR_OS_OFF    0   // default: sr_extern faults exactly as it always did
#define SR_OS_HLE    1   // SelectThread is host-implemented; the switch works
#define SR_OS_TRACE  2   // SelectThread stays TRANSLATED; the host provides the
                         // context primitives and STOPS at OSLoadContext, so the
                         // translated function itself can be used as the oracle
                         // for the HLE (CONTEXT_SWITCH.md §5, differential B).

// ------------------------------------------------- fault codes (0xC5 prefix)
// Distinct from sr_extern (0xE0), sr_indirect (0xE1) and sr_call (0xBAD0) so a
// differential can tell a host-OS refusal apart from a translator hole.
#define SR_F_IDLE_NO_IRQ     0xC5010000u  // RunQueueBits==0 and nothing can ever set it
#define SR_F_SAVECTX_HLE     0xC5020000u  // OSSaveContext reached under HLE (impossible)
#define SR_F_LOADCTX_EXC     0xC5030000u  // OSLoadContext exception-return path: unbuilt
#define SR_F_NO_HOST_THREAD  0xC5040000u  // out of pre-created host threads
#define SR_F_NO_CONT         0xC5050000u  // resume of a guest thread with no continuation
#define SR_F_FELL_OFF        0xC5060000u  // a guest thread entry RETURNED (no OSExitThread)
#define SR_F_PARK_TIMEOUT    0xC5070000u  // hand-off deadlock; the watchdog fired
#define SR_F_NOT_DISPATCH    0xC5080000u  // srr0 is not a translated function start

// ----------------------------------------------------------- trace events
#define SR_EV_DISABLE_IRQ    1
#define SR_EV_ENABLE_IRQ     2
#define SR_EV_RESTORE_IRQ    3
#define SR_EV_SET_CTX        4
#define SR_EV_GET_CTX        5
#define SR_EV_CLEAR_CTX      6
#define SR_EV_SELECT_ENTER   10   // a = yield,        b = __gCurrentThread
#define SR_EV_SELECT_SAVE    11   // a = ctx saved,    b = srr0 recorded
#define SR_EV_HANDOFF        12   // a = from thread,  b = to thread
#define SR_EV_START_THREAD   13   // a = to thread,    b = srr0 dispatched at
#define SR_EV_RESUMED        14   // a = my thread,    b = host slot
#define SR_EV_SELECT_RETURN  15   // a = r3 returned,  b = __gCurrentThread
#define SR_EV_THREAD_ENTRY   16   // a = host slot,    b = guest pc
#define SR_EV_THREAD_EXIT    17   // a = host slot,    b = guest thread
#define SR_EV_SAVECTX        20   // TRACE mode: a = ctx, b = srr0
#define SR_EV_LOADCTX        21   // TRACE mode: a = ctx, b = srr0  (the rfi point)

// --------------------------------------------------------- the SAB OS ABI
// RECOVERED FROM THE TRANSLATED CODE, not from a header.  Every constant below is
// cited to the guest instruction that materialises it; see CONTEXT_SWITCH.md §3.
//   0x800ebd6c 3c80802c  lis   r4, 0x802c      \  RunQueue base =
//   0x800ebd7c 3be4abb8  addi  r31, r4, -21576 /  0x802c0000 - 0x5448 = 0x802babb8
//   0x800ebda0 3c808000  lis   r4, 0x8000      \  __gCurrentThread = 0x800000e4
//   0x800ebda4 80c400e4  lwz   r6, 0xe4(r4)    /
//   0x800e5630 3c608000 / 806300d4             -> __OSCurrentContext = 0x800000d4
//   0x800e55e0 90a400c0                        -> __OSCurrentPhysContext = 0x800000c0
//   0x800e55e4 80a400d8                        -> __OSFPUContext        = 0x800000d8
//   0x800ebd88 800d8a28  lwz r0, -30168(r13)   -> Reschedule
//   0x800ebd78/…8a20     lwz/stw   -30176(r13) -> RunQueueBits
//   0x800ebe58/…8a24     stw       -30172(r13) -> RunQueueHint
#define SAB_RUNQUEUE_BASE        0x802babb8u
#define SAB_G_CURRENT_THREAD     0x800000e4u
#define SAB_OS_CURRENT_CONTEXT   0x800000d4u
#define SAB_OS_CURRENT_PHYS_CTX  0x800000c0u
#define SAB_OS_FPU_CONTEXT       0x800000d8u
#define SAB_SDA_RESCHEDULE       (-30168)
#define SAB_SDA_RUNQUEUEBITS     (-30176)
#define SAB_SDA_RUNQUEUEHINT     (-30172)
#define SAB_IDLE_CONTEXT         (SAB_RUNQUEUE_BASE + 1824u)   /* 0x800ebe94 387f0720 */

// OSContext / OSThread field offsets — ~/gc_refs/dolsdk2001/include/dolphin/os/
// OSContext.h:12-98 and OSThread.h:38-55, each one confirmed against the shipped
// bytes (CONTEXT_SWITCH.md §3).
#define OSCTX_GPR(n)   ((uint32_t)((n) * 4))
#define OSCTX_CR       128u
#define OSCTX_LR       132u
#define OSCTX_CTR      136u
#define OSCTX_XER      140u
#define OSCTX_SRR0     408u
#define OSCTX_SRR1     412u
#define OSCTX_MODE     416u
#define OSCTX_STATE    418u
#define OSCTX_GQR(n)   ((uint32_t)(420u + (n) * 4u))
#define OSCTX_STATE_EXC       0x02u
#define OSCTX_STATE_FPSAVED   0x01u

#define OSTH_STATE     712u   /* 0x2c8 */
#define OSTH_PRIORITY  720u   /* 0x2d0 */
#define OSTH_QUEUE     732u   /* 0x2dc */
#define OSTH_LINK_NEXT 736u   /* 0x2e0 */
#define OSTH_LINK_PREV 740u   /* 0x2e4 */

// The guest addresses this layer answers for.  Feed the same list to sr.py --host
// so the translator leaves them out of the emitted set.
#define SAB_OSDisableInterrupts   0x800e78acu
#define SAB_OSEnableInterrupts    0x800e78c0u
#define SAB_OSRestoreInterrupts   0x800e78d4u
#define SAB_OSSetCurrentContext   0x800e55d4u
#define SAB_OSGetCurrentContext   0x800e5630u
#define SAB_OSClearContext        0x800e579cu
#define SAB_OSSaveContext         0x800e563cu
#define SAB_OSLoadContext         0x800e56bcu
#define SAB_SelectThread          0x800ebd68u

int  sr_host_call(GekkoState *st, uint32_t addr);   // 1 = handled, 0 = not ours

#endif
