// [audio, RECOMP_MUSYX=1] MusyX's SAL (system abstraction layer) backend for the wasm recomp.
//
// REPLACES extern/musyx/src/musyx/runtime/hw_pc.c, which build_wasm.sh excludes when this file
// is compiled. hw_pc.c is not a software backend — it is the library's do-nothing target:
// `salAiGetDest()` returns NULL (hw_pc.c:89), `salStartAi()` has no body (:82), `salStartDsp()`
// is empty (:99), and every AI/DSP call is commented out. It is byte-identical to the copy in
// ~/gc_refs/ttyd/libs/musyx, so that is the library's stub, not an MP4 quirk. Nothing in it can
// ever produce a sample.
//
// The GameCube backend (hw_dolphin.c) cannot be used either: salInitDsp does DSPInit/DSPAddTask
// and then spins on `while (!salDspInitIsDone)` waiting for a DSP interrupt that does not exist
// here, and it uploads the `dspSlave` GC-DSP microcode blob, which is machine code for a
// processor this port does not emulate.
//
// So this file keeps hw_dolphin.c's STRUCTURE — the 4-deep AI buffer rotation and the callback
// chain — and swaps the one step that needed the DSP: instead of mailing a command list to the
// microcode, it runs the software mixer (gc_musyx_mix.c) over the very parameter blocks
// salBuildCommandList just finished setting up.
//
// THE CHAIN, once this is wired (all of it is the game's own, none of it is scheduling we
// invent):  AI DMA completion (driven from emulated time by gc_musyx_ai.c)
//             -> msmSysServer            (src/msm/msmsys.c:10, registered at :887)
//                  -> msmMus/Se/StreamPeriodicProc every 3rd tick
//                  -> sys.oldAIDCallback()  == salCallback, saved here at registration
//                       -> snd_handle_irq  (hardware.c:28, passed to salInitAi at :103)
//                            -> salCtrlDsp(salAiGetDest())
//                                 -> salBuildCommandList  (updates every _PB for this frame)
//                                 -> __recomp_musyx_mix   (this port's DSP)

#include "musyx/platform.h"
#include "musyx/assert.h"
#include "musyx/hardware.h"
#include "musyx/sal.h"

#include <string.h>

#define DMA_BUFFER_LEN 0x280        /* hw_dolphin.c:24 — 160 stereo s16 frames = 5 ms @ 32 kHz */

extern void __recomp_musyx_mix(s16 *dest);          /* gc_musyx_mix.c */
extern void __recomp_ai_present(const void *buf);   /* gc_musyx_ai.c  */
typedef void (*AIDCallback)(void);
extern AIDCallback AIRegisterDMACallback(AIDCallback cb);
extern void AIInitDMA(u32 addr, u32 length);
extern void AIStartDMA(void);
extern void AIStopDMA(void);

static volatile u32 salLogicActive = 0;
static volatile u32 salLogicIsWaiting = 0;
static volatile u32 salDspIsDone = 0;
void *salAIBufferBase = NULL;
static u8 salAIBufferIndex = 0;
static SND_SOME_CALLBACK userCallback = NULL;
static volatile u16 hwIrqLevel = 0;

u32 salGetStartDelay(void);

static void callUserCallback(void) {
    if (salLogicActive) return;
    salLogicActive = 1;
    userCallback();
    salLogicActive = 0;
}

/* hw_dolphin.c:36-46, minus the OSCachedToPhysical/AIInitDMA pair that a real DMA engine needs.
 * The buffer rotation is kept because salAiGetDest's "index + 2" depends on it: the mixer must
 * write the buffer two ahead of the one currently playing, or it would overwrite live samples. */
void salCallback(void) {
    salAIBufferIndex = (u8)((salAIBufferIndex + 1) % 4);
    if (salDspIsDone) callUserCallback();
    else salLogicIsWaiting = 1;
}

void dspInitCallback(void) { salDspIsDone = TRUE; }

void dspResumeCallback(void) {
    salDspIsDone = TRUE;
    if (salLogicIsWaiting) { salLogicIsWaiting = FALSE; callUserCallback(); }
}

bool salInitAi(SND_SOME_CALLBACK callback, u32 unk, u32 *outFreq) {
    (void)unk;
    if ((salAIBufferBase = salMalloc(DMA_BUFFER_LEN * 4)) == NULL) return FALSE;
    memset(salAIBufferBase, 0, DMA_BUFFER_LEN * 4);
    salAIBufferIndex = 1;
    salLogicIsWaiting = FALSE;
    salDspIsDone = TRUE;
    salLogicActive = FALSE;
    userCallback = callback;
    /* Register with the AI exactly as hw_dolphin.c:73 does. This matters for ordering: the msm
     * layer replaces this callback at msmsys.c:887 and keeps ours as sys.oldAIDCallback, so
     * MusyX only ever runs if it was registered FIRST — which it is, because sndInit (and
     * therefore hwInit -> salInitAi) is called at msmsys.c:885, two lines earlier. */
    AIRegisterDMACallback(salCallback);
    synthInfo.numSamples = 0x20;
    *outFreq = 32000;
    return TRUE;
}

bool salStartAi(void) { AIStartDMA(); return TRUE; }

bool salExitAi(void) {
    AIRegisterDMACallback(NULL);
    AIStopDMA();
    salFree(salAIBufferBase);
    salAIBufferBase = NULL;
    return TRUE;
}

/* hw_dolphin.c:91-95 — the mixer writes two buffers ahead of the one the AI is playing. */
void *salAiGetDest(void) {
    u8 index = (u8)((salAIBufferIndex + 2) % 4);
    return (void *)((u8 *)salAIBufferBase + index * DMA_BUFFER_LEN);
}

bool salInitDsp(u32 flags) { (void)flags; salDspIsDone = TRUE; return TRUE; }
bool salExitDsp(void) { return TRUE; }

/* Unused here — the mixer is driven from salCtrlDsp, which has the destination pointer that
 * salStartDsp does not. Kept because sal.h declares it and MusyX may reference it. */
void salStartDsp(u16 *cmdList) { (void)cmdList; salDspIsDone = TRUE; }

void salCtrlDsp(s16 *dest) {
    /* salBuildCommandList is still run in full, and this is deliberate: it is not only the
     * command emitter, it is the per-frame VOICE UPDATE — it starts and retires voices, sets
     * every PB's addresses and ADPCM coefficients, computes the volume ramps and the ADSR, and
     * fills the patch list the mixer reads. The command list it also emits is then simply not
     * mailed anywhere. */
    salBuildCommandList(dest, salGetStartDelay());
    __recomp_musyx_mix(dest);
    __recomp_ai_present(dest);
    salDspIsDone = TRUE;
}

/* On hardware this is the microseconds since the last AI interrupt, used only to budget DSP
 * cycles for the command list (hw_dspctrl.c:441-446). The software mixer has no cycle budget to
 * exceed, and reading a wall clock here would let host timing leak into the guest's audio
 * scheduling — forbidden by the product definition. A constant 0 takes the `nsDelay < 200`
 * branch, i.e. the minimum budget, deterministically. */
u32 salGetStartDelay(void) { return 0; }

/* ---- audio self-test hook ----------------------------------------------------------------
 * Starts one real sound effect out of the loaded bank, on demand, from the host.
 *
 * WHY IT EXISTS: "does the mixer turn the bank into PCM?" and "does the boot reach a screen
 * that plays something?" are two different questions, and the second one was blocking the
 * first. The Node probe parks on the title screen — 1800 retraces in, the voice manager had
 * still never started a voice (`voiceMgrBusy=0`), so the mixer had never been handed anything
 * to render and its output was silence that proved nothing. This calls msmSePlay directly
 * (src/msm/msmse.c:504), which is the same entry point the game's own HuAudSePlay uses, so the
 * sound is a real sample from the real sample directory going through the real voice manager —
 * only the trigger is synthetic.
 *
 * It is a MEASUREMENT ARM, never part of playback: nothing in the game calls it, it is reached
 * only by a host that explicitly asks, and it neither reads nor writes any clock. */
/* seId >= 0 : sweep msmSePlay over [seId, seId+SWEEP). A single id is not a useful probe —
 *             msmSePlay can return a valid entry id and still never sound, because the sound's
 *             MACRO may live in a group that this point of the boot has not loaded, in which
 *             case dataInsertMacro stored NULL and the voice dies before it starts a sample.
 *             Sweeping finds one whose group IS resident. Returns how many were accepted.
 * seId <  0 : msmStreamPlay(-seId - 1) instead — the streamed path (title/menu music), which
 *             does not go through the macro pool at all. */
#define SELFTEST_SWEEP 24
s32 __recomp_audio_selftest(s32 seId) {
    extern int msmSePlay(int seId, void *param);
    extern int msmStreamPlay(int streamId, void *param);
    s32 i, okN = 0;
    if (seId < 0) return (s32)msmStreamPlay((int)(-seId - 1), (void *)0);
    for (i = 0; i < SELFTEST_SWEEP; i++)
        if (msmSePlay((int)(seId + i), (void *)0) >= 0) okN++;
    return okN;
}

/* Interrupt discipline. The recomp is single-threaded and the AI callback is driven
 * synchronously from VIWaitForRetrace, i.e. at a point where the guest is already blocked, so
 * there is no preemption to guard against and these are the no-ops hw_pc.c also made them.
 * The nesting counter is kept so the enable/disable pairing stays observable. */
void hwInitIrq(void) { hwIrqLevel = 1; }
void hwExitIrq(void) {}
void hwEnableIrq(void) { if (hwIrqLevel) --hwIrqLevel; }
void hwDisableIrq(void) { ++hwIrqLevel; }
void hwIRQEnterCritical(void) {}
void hwIRQLeaveCritical(void) {}
