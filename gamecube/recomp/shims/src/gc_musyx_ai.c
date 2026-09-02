// [audio, RECOMP_MUSYX=1] The Audio Interface (AI) for the recomp — the thing that turns
// "MusyX has filled a buffer" into "the page's AudioWorklet has samples".
//
// WHAT THE HARDWARE DOES, and what this reproduces exactly:
//   The GameCube AI plays a DMA buffer of DMA_BUFFER_LEN bytes at 32 kHz and raises an
//   interrupt when it drains. MusyX sizes that buffer at 0x280 bytes = 640 B = 160 stereo
//   s16 frames = 5 ms, so the AI interrupt fires 200x per second (the same 200/s constant
//   CLAUDE.md names as the GameCube's guest-rate witness). The handler queues the next
//   buffer and asks the mixer to fill the one after it — a 4-deep rotation
//   (hw_dolphin.c:36-46 salCallback / :91-95 salAiGetDest).
//
//   The interrupt chain the game actually installs is two-deep:
//     AI DMA done -> msmSysServer (src/msm/msmsys.c:10, registered at :887)
//                      -> every 3rd tick: msmMus/Se/StreamPeriodicProc
//                      -> sys.oldAIDCallback()  == MusyX's salCallback
//                           -> callUserCallback -> salCtrlDsp(salAiGetDest())
//                              -> salBuildCommandList (updates every _PB) + the mixer
//   So driving ONE callback at 200 Hz drives the sequencer, the voice manager and the mixer,
//   with no extra scheduling of our own. That is why this file models the AI rather than
//   calling into MusyX directly: the cadence and the ordering are the game's, not ours.
//
// GATE #9 — THE CLOCK. __recomp_audio_pump is called from VIWaitForRetrace (recomp_worker.js
// pumpAudio, called right after viRetrace++), and is asked for a sample count derived from
// viRetrace — EMULATED time. It never reads performance.now(), never blocks, and never
// signals back into the guest. So audio cannot pull, push, or stretch the guest clock: if the
// guest runs slow the audio simply produces fewer samples, exactly as a real console driven by
// a slow VI would. Nothing here can speed the guest up or slow it down, which is the property
// the product definition requires. It also makes samples/second an independent witness of the
// guest rate: 200 AI ticks per emulated second is 32000 samples, so a drift in the guest clock
// shows up as a drift in the sample count.
//
// WHY A RING: the pump asks for ~533 frames per video frame (32000/60) but the AI produces in
// 160-frame quanta, so the two never line up. The ring absorbs the remainder. It is sized for
// well over one video frame of slack so a late pump cannot drop a block.

#include <string.h>

typedef unsigned char u8;   typedef signed char s8;
typedef unsigned short u16; typedef short s16;
typedef unsigned long u32;  typedef long s32;

#define AI_DMA_BYTES   0x280                   /* MusyX's DMA_BUFFER_LEN (hw_dolphin.c:24)  */
#define AI_FRAMES_PER_DMA (AI_DMA_BYTES / 4)   /* 160 stereo frames                          */
#define AI_TICKS_PER_SEC  200                  /* 32000 / 160                                */

typedef void (*AIDCallback)(void);

static AIDCallback ai_cb;                      /* whatever AIRegisterDMACallback last stored */
static u32  ai_dma_addr;                       /* physical addr handed to AIInitDMA          */
static u32  ai_dma_len;
static int  ai_running;
static int  ai_inited;

/* ---- output ring (stereo s16 frames) --------------------------------------------------- */
/* 8192 frames = 256 ms, ~15x one video frame's demand. */
#define RING_FRAMES 8192
static s16 ring[RING_FRAMES * 2];
static u32 ring_w, ring_r;

/* Staging buffer the worker copies out of. Sized for the largest single pump request; one
 * video frame at 32 kHz is 534 frames, and a long stall could ask for more, so allow 4x. */
#define STAGE_FRAMES 4096
static s16 stage[STAGE_FRAMES * 2];

static u32 ring_count(void) { return ring_w - ring_r; }

static void ring_push(const s16 *src, u32 frames) {
    for (u32 i = 0; i < frames; i++) {
        if (ring_count() >= RING_FRAMES) { ring_r++; }   /* overrun: drop oldest, stay live */
        u32 s = (ring_w % RING_FRAMES) * 2;
        ring[s] = src[i * 2]; ring[s + 1] = src[i * 2 + 1];
        ring_w++;
    }
}

/* ---- AI SDK surface (replaces the host-import stubs in recomp_worker.js) ---------------- */
/* These were previously answered by the worker's generic `default: return 0`, which is why
 * nothing ever drove the audio engine: the callback was accepted and then never called. */

void AIInit(void *stack) { (void)stack; ai_inited = 1; }

AIDCallback AIRegisterDMACallback(AIDCallback cb) {
    AIDCallback old = ai_cb;
    ai_cb = cb;
    return old;
}

void AIInitDMA(u32 addr, u32 length) { ai_dma_addr = addr; ai_dma_len = length; }
void AIStartDMA(void) { ai_running = 1; }
void AIStopDMA(void)  { ai_running = 0; }
u32  AIGetDMABytesLeft(void) { return 0; }
u32  AIGetDMAStartAddr(void) { return ai_dma_addr; }
u32  AIGetDMALength(void)    { return ai_dma_len; }

/* MusyX's backend (gc_musyx_hw.c) publishes the buffer the mixer just filled here, because the
 * AI's DMA address is a PHYSICAL address on hardware and this port has no MMU to resolve one.
 * Keeping the handoff explicit also means the AI never has to guess a pointer. */
static const s16 *ai_play_buf;
void __recomp_ai_present(const void *buf) { ai_play_buf = (const s16 *)buf; }

/* One AI DMA completion: hand the buffer that just "played" to the ring, then run the guest's
 * interrupt handler, which refills the next one. Ordering matches the hardware — the interrupt
 * fires because a buffer finished, so that buffer's samples are already committed. */
static void ai_tick(void) {
    if (ai_play_buf) ring_push(ai_play_buf, AI_FRAMES_PER_DMA);
    if (ai_cb) ai_cb();
}

/* ---- the worker-facing pump ------------------------------------------------------------- */
/* Returns the number of stereo frames staged at __recomp_audio_base(). Runs AI ticks until the
 * ring can satisfy the request, bounded so a mixer that produces nothing cannot spin forever. */
s32 __recomp_audio_pump(s32 want) {
    if (want <= 0) return 0;
    if (want > STAGE_FRAMES) want = STAGE_FRAMES;
    if (!ai_running || !ai_cb) return 0;

    /* +1 tick of headroom keeps the ring from running dry on the 533/534 alternation. */
    int guard = (want / AI_FRAMES_PER_DMA) + 4;
    while (ring_count() < (u32)want && guard-- > 0) ai_tick();

    u32 have = ring_count();
    u32 n = (have < (u32)want) ? have : (u32)want;
    for (u32 i = 0; i < n; i++) {
        u32 s = (ring_r % RING_FRAMES) * 2;
        stage[i * 2] = ring[s]; stage[i * 2 + 1] = ring[s + 1];
        ring_r++;
    }
    return (s32)n;
}

void *__recomp_audio_base(void) { return stage; }

/* Diagnostics: the worker logs these so "silent" can be attributed to a specific stage —
 * no AI (never started), no ticks (callback never registered), or ticks but no signal
 * (the mixer produced zeros). */
s32 __recomp_audio_stat(s32 which) {
    switch (which) {
    case 0: return ai_running;
    case 1: return ai_cb ? 1 : 0;
    case 2: return (s32)ring_count();
    case 3: return ai_inited;
    default: return 0;
    }
}
