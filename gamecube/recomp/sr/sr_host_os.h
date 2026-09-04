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
                         //
                         // THE CLOCK (sr_tb_*) is answered in every mode that is not
                         // SR_OS_OFF, exactly like the MSR family, and has its own
                         // independent run-time switch `sr_tb_enable()` so a control
                         // arm can turn the clock off WITHOUT turning the MSR
                         // boundary off.  See "THE GUEST TIMEBASE" below.
#define SR_OS_IRQ    3   // THE MSR FAMILY ONLY -- OSDisableInterrupts,
                         // OSEnableInterrupts, OSRestoreInterrupts and the two
                         // __TRK_get_MSR/__TRK_set_MSR pairs.  Everything else
                         // (the context primitives, SelectThread) still faults by
                         // name, so this mode adds exactly one word of host state
                         // (`g_msr`) and NO threading: it needs no `-pthread`, no
                         // host thread pool, and no `sr_os_init`.  See
                         // README.md §9.7 -- this is the boundary whose blast
                         // radius is 745 blocked DOL functions.
#define SR_OS_CTX    4   // SR_OS_IRQ *PLUS* the three CONTEXT primitives that need
                         // NO host thread: OSSetCurrentContext, OSGetCurrentContext
                         // and OSClearContext.  Like SR_OS_IRQ it creates no thread,
                         // calls nothing from <pthread.h> and needs no -pthread
                         // (`sr_os_init_ctx()`); unlike SR_OS_HLE it does NOT answer
                         // for OSSaveContext / OSLoadContext / SelectThread, which
                         // stay REFUSED so the caller faults and names them.
                         //
                         // WHY THIS TIER EXISTS AT ALL, rather than "just link HLE".
                         // The three it answers for are pure guest-memory + GPR + MSR
                         // transcriptions of ~/gc_refs/dolsdk2001/src/os/OSContext.c
                         // :200-238 and :390-395 -- straight-line code with no control
                         // transfer, which is why a host C function can BE them.  The
                         // three it refuses cannot be host C functions at this cut:
                         // OSSaveContext is a setjmp that RETURNS TWICE and
                         // OSLoadContext is its rfi (CONTEXT_SWITCH.md §2, measured to
                         // throw out of the module under BOTH longjmp backends), so
                         // they are reachable only through the SelectThread cut, one
                         // host thread per guest thread, which needs -pthread and
                         // sr_os_init().  Collapsing the two tiers into one mode would
                         // make "the context boundary is on" mean two different things
                         // depending on how the image was linked -- and the whole-image
                         // boot is linked WITHOUT -pthread today (build_image.sh).

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
#define SR_F_TB_STALL        0xC5090000u  // the guest read the timebase SR_TB_STALL_MAX
                                          // times with no guest work credited between
                                          // the reads -- i.e. it is spinning on a clock
                                          // that cannot advance.  See "THE STALL FAULT".

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
#define SR_EV_GET_MSR        22   // a = MSR returned  (__TRK_get_MSR)
#define SR_EV_SET_MSR        23   // a = MSR written   (__TRK_set_MSR)
#define SR_EV_GET_TIME       24   // a = TBU returned, b = TBL returned (OSGetTime)
#define SR_EV_GET_TICK       25   // a = TBL returned                   (OSGetTick)
#define SR_EV_SET_DEC        26   // a = DEC written,  b = TBL at the write (PPCMtdec)
#define SR_EV_DEC_EXC        27   // a = the tick the decrementer went negative at,
                                  // b = the running count of undelivered exceptions

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
// The Metrowerks TRK debugger runtime's MSR accessors.  SAB links TWO byte-identical
// copies of each; both are `mfmsr r3; blr` / `mtmsr r3; blr` verbatim:
//   0x800e3494 7c6000a6 4e800020   __TRK_get_MSR      0x800e349c 7c600124 4e800020  __TRK_set_MSR
//   0x80108e98 7c6000a6 4e800020   __TRK_get_MSR      0x80108ea0 7c600124 4e800020  __TRK_set_MSR
// They are the same primitive as OSDisableInterrupts' first and third instructions,
// so they belong to this boundary rather than to a second one.
#define SAB_TRK_get_MSR_A         0x800e3494u
#define SAB_TRK_set_MSR_A         0x800e349cu
#define SAB_TRK_get_MSR_B         0x80108e98u
#define SAB_TRK_set_MSR_B         0x80108ea0u
#define SAB_OSSetCurrentContext   0x800e55d4u
#define SAB_OSGetCurrentContext   0x800e5630u
#define SAB_OSClearContext        0x800e579cu
#define SAB_OSSaveContext         0x800e563cu
#define SAB_OSLoadContext         0x800e56bcu
#define SAB_SelectThread          0x800ebd68u

// ==========================================================================
//                            THE GUEST TIMEBASE
// ==========================================================================
// The three addresses below are ONE FACILITY -- the Gekko time base and its
// decrementer -- and they are the largest remaining closure boundary in main.dol
// after the MSR family (README.md §9.7).  Read from the SHIPPED WORDS, not from
// the map, which names 0x800e34bc "PPCMtwpar" and is wrong (SPR 22 is DEC; WPAR
// is SPR 921):
//
//   0x800ecb48 OSGetTime   7c6d42e6 mftbu r3  / 7c8c42e6 mftb  r4 / 7cad42e6 mftbu r5
//                          7c032800 cmpw r3,r5 / 4082fff0 bne -16 / 4e800020 blr
//   0x800ecb60 OSGetTick   7c6c42e6 mftb  r3  / 4e800020 blr
//   0x800e34bc PPCMtdec    7c7603a6 mtspr 22,r3 / 4e800020 blr
//
// ~/gc_refs/dolsdk2001/src/os/OSTime.c is the same code as C: OSGetTime is the
// carry-safe TBU/TBL/TBU retry loop returning the 64-bit tick in r3:r4, OSGetTick
// is one mftb.  ~/gc_refs/dolsdk2001/src/os/OSAlarm.c:37-46 SetTimer is the whole
// reason PPCMtdec belongs in the same boundary: it computes
// `alarm->fire - OSGetTime()` and PPCMtdec's the result, so the two are used as a
// pair and freeing one without the other frees almost nothing.  MEASURED, with
// rel_shapes.classify on top of the SR_OS_IRQ set: PPCMtdec alone is worth
// +0 functions, but dropping it from the set costs -112.
//
// --------------------------------------------------------------------------
// THE INVARIANT -- and why a host wall clock is a BUG, not a shortcut
// --------------------------------------------------------------------------
//     TB  = TB_origin + floor(GUEST_CYCLES_RETIRED / 12)
//     DEC = DEC_at_write - floor((GUEST_CYCLES_RETIRED - cycles_at_write) / 12)
//
// GUEST_CYCLES_RETIRED is produced ONLY by guest execution events, credited
// through sr_tb_credit_*.  THE HOST CLOCK IS NEVER AN INPUT TO THE RATE.  A host
// wall-clock ORIGIN is legitimate and is what real hardware has (the RTC); a host
// wall-clock RATE is not.
//
// This is not a house rule -- it is what the reference implementation does.
// Dolphin, Source/Core/Core/HW/SystemTimers.cpp:213-218:
//     GetFakeTimeBase() = FakeTBStartValue
//                       + (CoreTiming::GetTicks() - FakeTBStartTicks) / TIMER_RATIO
// and :199-204 GetFakeDecrementer() is the same expression counting down.
// `CoreTiming::GetTicks()` is the EMULATED CPU CYCLE COUNTER, not wall time.
// SystemTimers.h:41 TIMER_RATIO = 12; SystemTimers.h:103 m_cpu_core_clock =
// 486000000, so the tick rate is 486/12 = 40.5 MHz -- the same constant CLAUDE.md
// gate #9 names.  The only wall-clock value Dolphin uses is the ORIGIN, taken once
// at boot from the RTC (SystemTimers.cpp:269, seconds-since-GC-epoch * 40.5e6).
//
// WHY IT MATTERS HERE, concretely.  This runtime does not deliver guest work at
// hardware rate: the honest JIT figure on SAB cold-boot attract is 0.3781x
// delivered (README.md §8.6b).  Drive TB from `emscripten_get_now()` and the guest
// sees 1.000 s of TIME pass for every ~0.38 s of WORK it retired -- its own
// time:work ratio, which is a CONSTANT of the hardware, becomes a function of the
// host.  Every guest deadline fires early, every measured interval reads long,
// and two replays of the same computation return different answers, so no
// differential against the oracle can ever be bit-exact.  In the other direction
// -- a host FASTER than hardware, which is the whole point of the 120 headroom
// target -- the same wall clock makes guest time run SLOW relative to guest work.
// Both directions are the gate #9 failure: the guest is no longer being "ran
// precisely as the hardware intended".  Deriving TB from retired guest work makes
// the ratio exactly hardware's AT ANY HOST SPEED, and leaves "how much wall time
// one second of guest time costs" as a quantity measured OUTSIDE the guest --
// which is exactly gate #9's second, independent knob.
//
// HOW A VIOLATION IS DETECTED.  Three standing checks, none of them an argument:
//   1. `sr.py --tb-audit` enumerates every instruction in the image that can
//      observe or alter TB/DEC (mftb, mfspr/mtspr naming TBL/TBU/TBR/DEC) and
//      proves each owner is either --host-bound or REFUSED by the translator.  It
//      exits 2 if any such function would be EMITTED.  That is the same shape as
//      --msr-audit and it is what makes g_tb the ONLY representation of the
//      timebase inside the emitted image.
//   2. DETERMINISM.  Replay the same guest work twice with the same seed: a
//      retire-driven clock returns the same TB delta bit for bit, a wall-clock one
//      cannot.  verify_fixture.mjs scores tb/dec as outputs, so this is not a
//      separate rig.
//   3. There is no host-time symbol in this facility's implementation at all --
//      grep sr_host_os.c for emscripten_get_now / clock_gettime / gettimeofday /
//      time( and the timebase section returns nothing.
//
// --------------------------------------------------------------------------
// THE STALL FAULT -- what a frozen clock does instead of lying
// --------------------------------------------------------------------------
// If no driver credits guest cycles, TB is FROZEN.  A guest that polls OSGetTime
// waiting for an interval would then spin for ever.  That is a worse user
// experience than a wrong number but a far better engineering property: it is
// LOUD.  After SR_TB_STALL_MAX consecutive timebase reads with zero credit in
// between, the facility raises SR_F_TB_STALL and names the caller, so an
// unattached driver is a diagnosable fault instead of a silent wrong rate.
//
// --------------------------------------------------------------------------
// WHAT IS NOT MODELLED, stated so nothing here implies completeness
// --------------------------------------------------------------------------
//  * DECREMENTER INTERRUPT DELIVERY.  The DEC register is exact; its CONSEQUENCE
//    is not modelled.  Dolphin's DecrementerCallback (SystemTimers.cpp:139-143)
//    sets DEC = 0xFFFFFFFF and raises EXCEPTION_DECREMENTER; there is no interrupt
//    delivery in this runtime at all (README §6, CONTEXT_SWITCH.md §7.1), and the
//    8 non-SelectThread OSLoadContext sites -- the exception-RETURN paths -- still
//    fault SR_F_LOADCTX_EXC.  So this facility COUNTS the exceptions that would
//    have been delivered (sr_tb_dec_exceptions()) and delivers none.  The direct
//    consequence: OSSetAlarm/OSInitAlarm program a timer whose handler never runs,
//    so an alarm-driven guest wait does not complete.  That is the SAME pre-existing
//    hole MSR[EE] has -- the bit's value is exact, its effect is absent -- and this
//    change neither widens nor narrows it.
//  * WRITING the timebase.  mttbl/mttbu (SPR 284/285) appear in exactly one image
//    function, 0x8010a86c TRKRestoreExtended1Block (the Metrowerks debug monitor's
//    context restore).  It is REFUSED by the translator and stays refused: a debug
//    monitor restoring the TB is not a path a running game takes, and host-binding
//    it would mean transcribing 440 bytes of debugger for zero closure gain.
//  * A SECOND IN-IMAGE TIMEBASE READER, 0x80169ae8, is deliberately NOT host-bound.
//    Its shipped words are a C-compiled OSGetTime -- mftbu r4 / mftb r31 / mftbu r0
//    / cmpw / bne, then `li r3,0; li r5,32; bl 0x8010b338` (a 64-bit shift helper)
//    and `or r4,r4,r31`, i.e. it returns r3:r4 = TBU:TBL like the asm one -- so the
//    VALUE is the same primitive.  The FUNCTION is not: it takes a stack frame and
//    writes r0 and r31 to it (stw r0,4(r1) / stw r31,12(r1)), and the fixture
//    differential scores the ordered memory write log, so host-binding it would
//    silently delete two writes the oracle recorded.  MEASURED cost of leaving it
//    out: 8 functions.  The three addresses this facility DOES answer for are all
//    leaves that touch no memory and take no frame, which is why they are safe.
#define SAB_OSGetTime             0x800ecb48u
#define SAB_OSGetTick             0x800ecb60u
#define SAB_PPCMtdec              0x800e34bcu

// Gekko clock constants.  Every one is Dolphin's, cited above.
#define GK_CPU_HZ            486000000u   /* SystemTimers.h:103                   */
#define GK_TIMER_RATIO              12u   /* SystemTimers.h:41   CPU cyc per tick */
#define GK_TB_HZ              40500000u   /* = GK_CPU_HZ / GK_TIMER_RATIO         */
#define GK_TB_PER_FIELD         675000u   /* = GK_TB_HZ / 60, one 60 Hz field     */
#define GK_CYCLES_PER_FIELD    8100000u   /* = GK_TB_PER_FIELD * GK_TIMER_RATIO   */
#define SR_TB_STALL_MAX          100000u  /* reads with no credit -> SR_F_TB_STALL */

// ---- the clock, driven by GUEST work only ---------------------------------
// Credit retired guest execution.  This is the ONE input to the rate; there is no
// other.  `cycles` is in Gekko CPU cycles, the same unit as Dolphin's
// CoreTiming::GetTicks(), and the fractional tick is carried, never dropped.
void     sr_tb_credit_cycles(uint64_t cycles);
// One 60 Hz field of guest work: +675,000 ticks.  This is the driver the shipping
// MP4 recomp path already uses and measures at 0.999x -- recomp_worker.js:786
// returns `viRetrace * 675000n` for OSGetTime, bumped once per VIWaitForRetrace.
// Call it from the guest's retrace boundary, never from a host timer.
void     sr_tb_retrace(void);
// Seed the ORIGIN.  Legitimate from a captured guest TB (a fixture's state_in) or
// from an RTC at boot, exactly as SystemTimers.cpp:269 does -- ONCE, as an origin,
// never as a rate.
void     sr_tb_seed(uint64_t tb);
uint64_t sr_tb_read(void);
uint32_t sr_dec_read(void);
void     sr_dec_write(uint32_t v);

int  sr_host_call(GekkoState *st, uint32_t addr);   // 1 = handled, 0 = not ours

// Install the hook WITHOUT creating any host thread and WITHOUT needing -pthread.
// This is what a plain (non-context-switch) build calls to get SR_OS_IRQ; the
// thread pool belongs to SelectThread, and SelectThread is not in this mode.
int  sr_os_init_irq(void);
// The same, one tier up: SR_OS_CTX.  Still no host thread and still no -pthread --
// see the SR_OS_CTX note above for exactly which three primitives that buys and why
// the other three cannot come with them.
int  sr_os_init_ctx(void);

#endif
