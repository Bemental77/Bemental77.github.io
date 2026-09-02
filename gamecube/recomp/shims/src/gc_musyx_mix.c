// [audio, RECOMP_MUSYX=1] SOFTWARE AX MIXER — the thing that actually makes a sample.
//
// THE PROBLEM THIS SOLVES. Compiling MusyX into the recomp gets the sequencer, the voice
// manager and the DSP COMMAND-LIST BUILDER, and not one PCM sample. On real hardware every
// sample is mixed by the GameCube's DSP running MusyX's `dspSlave` microcode
// (extern/musyx/src/musyx/runtime/dsp_import.c:4 — 0x19E0 bytes of GC-DSP machine code, gated
// `#if MUSY_TARGET == MUSY_TARGET_DOLPHIN`). hw_dolphin.c:146 salCtrlDsp builds a command list
// and mails it to that ucode; there is no C fallback, because the MUSY_TARGET_PC backend is a
// STUB, not a software renderer (hw_pc.c:89 salAiGetDest returns NULL, :99 salStartDsp is
// empty). So the missing piece is a host-side implementation of what the ucode does: walk the
// voice parameter blocks, decode and resample each voice's sample data out of ARAM, apply its
// envelope and mix ramps, and sum to stereo.
//
// WHAT MUSYX'S _PB ACTUALLY IS. It is the standard GameCube AX parameter block. voice.h:113's
// `_PB` maps field-for-field onto Dolphin's `AXPB` (dolphin-src/.../UCodes/AXStructs.h):
//   _PBADDR{loopFlag,format,loopAddress,endAddress,currentAddress} = audio_addr{looping,
//     sample_format,loop_addr,end_addr,cur_addr};  _PBADPCM{a[8][2],gain,pred_scale,yn1,yn2} =
//   PBADPCM{coefs[16],...};  _PBADPCMLOOP = adpcm_loop_info;  _PBSRC = PBSampleRate;
//   _PBVE = PBVolumeEnvelope;  _PBMIX = PBMixer;  `state` = running;  `loopType` = is_stream.
// That means the authoritative reference for the arithmetic is not guesswork but Dolphin's own
// AX HLE, which is IN THIS REPO, and its accelerator model is shared with DSP-LLE so it is
// hardware-accurate rather than ucode-shaped. Every constant below is cited to it.
//
// WHICH AX DIALECT: MusyX writes mixerCtrl as 0x01=AuxA, 0x02=AuxB, 0x04=surround, 0x08=ramps,
// 0x10=DPL2/surround-for-non-STD (hw_dspctrl.c:734-756), and MAIN L/R are never gated. That is
// exactly Dolphin's OLD GC AX decoding for ucode CRC 0x4e8a8b21 (AX.cpp:288-325) — not the
// newer per-channel layout. The bit tests below follow that dialect.
//
// SCOPE OF THIS FIRST INCREMENT — stated plainly so no one reads more into the output than is
// there. It renders the DRY stereo mix: per-voice ADPCM/PCM8/PCM16 decode, resampling, volume
// envelope, and the main L/R ramps, summed across every active voice of every active studio.
// It does NOT render the aux sends (AuxA/AuxB, i.e. reverb/chorus/delay), the surround channel,
// studio-to-studio inputs, ITD, or the depop roll-off. Those are real MusyX features that will
// be missing from the sound, not silently-wrong ones: their volumes are simply not summed.
// Dolphin does not implement depop or ITD either (AX.h:6-7, AXVoice.h:536-540).

#include <string.h>

#include "musyx/musyx.h"
#include "musyx/dspvoice.h"
#include "musyx/voice.h"
#include "musyx/sal.h"

extern u8 salMaxStudioNum;
extern u8 salNumVoices;
extern DSPstudioinfo dspStudio[8];
extern DSPvoice* dspVoice;

/* ARAM is a flat 16 MB buffer in this port (shims/src/gc_aram.c). Sample bodies are DMA'd into
 * it by MusyX's own aramStoreData (hw_aramdma.c:165), and every _PB address below is an offset
 * into it in that format's unit. */
extern void *__recomp_aram_base(void);
#define ARAM_SIZE 0x1000000u

#define AX_FRAME_SAMPLES   160      /* one AI DMA buffer: 0x280 bytes / 4 = 160 stereo frames */
#define AX_SUBFRAME        32       /* salInitAi sets synthInfo.numSamples = 0x20 (hw_pc.c:76) */
#define AX_SUBFRAMES       5        /* 5 x 32 = 160; _PBUPDATE.updNum[5] has one slot each      */

/* ---- helpers ---------------------------------------------------------------------------- */

static s32 clamp_s16(s32 v) { return v > 0x7FFF ? 0x7FFF : (v < -0x8000 ? -0x8000 : v); }

#define HILO32(hi, lo) (((u32)(hi) << 16) | (u32)(lo))

/* ---- the DSP accelerator (DSPAccelerator.cpp) -------------------------------------------- */
/* A faithful model of the hardware sample-fetch unit: it owns the read cursor and the ADPCM
 * history, and it is re-seeded from the PB at every subframe exactly as Dolphin does
 * (AXVoice.h:177-188), so no state lives here across subframes. */

typedef struct {
    const u8 *aram;
    u32 cur, start, end;        /* start == the PB's loopAddress; AXVoice.h:179 */
    u16 fmt;
    s16 yn1, yn2;
    s16 gain;
    u16 pred_scale;
    int reads_stopped;
    /* loop context, consulted by the end-of-sample exception */
    int  looping, is_stream;
    u16  loop_ps; s16 loop_yn1, loop_yn2;
    const s16 *coefs;           /* &pb->adpcm.a[0][0], 16 entries = coefs[8][2] */
} Accel;

static u8 aram_rd(const Accel *a, u32 byte) {
    return (byte < ARAM_SIZE) ? a->aram[byte] : 0;
}

/* DSPAccelerator.h:83-90 — the format word's three bitfields. */
#define FMT_SIZE(f)   ((f) & 3)          /* 0=4bit 1=8bit 2=16bit */
#define FMT_DECODE(f) (((f) >> 2) & 3)   /* 0=ADPCM 1=MMIOPCMNoInc 2=PCM 3=MMIOPCMInc */
#define FMT_GAIN(f)   (((f) >> 4) & 3)   /* 0=/2048 1=/1 2=/65536 */

/* Raw fetch, DSPAccelerator.cpp:20-32. Note the address UNIT changes with the size field:
 * nibbles for 4-bit, bytes for 8-bit, halfwords (big-endian) for 16-bit. */
static s16 accel_fetch_raw(Accel *a) {
    switch (FMT_SIZE(a->fmt)) {
    case 0: {                                   /* 4-bit: high nibble first */
        u8 v = aram_rd(a, a->cur >> 1);
        return (a->cur & 1) ? (s16)(v & 0xF) : (s16)(v >> 4);
    }
    case 1:                                     /* 8-bit, read UNSIGNED (no sign extension) */
        return (s16)aram_rd(a, a->cur);
    default:                                    /* 16-bit big-endian */
        return (s16)(((u16)aram_rd(a, a->cur * 2) << 8) | aram_rd(a, a->cur * 2 + 1));
    }
}

/* AXVoice.h:139-166 — what happens when the read cursor runs off the end. */
static void accel_end_exception(Accel *a) {
    if (a->looping) {
        a->pred_scale = a->loop_ps & 0x7F;
        if (!a->is_stream) {
            a->yn1 = a->loop_yn1;
            a->yn2 = a->loop_yn2;              /* restoring yn2 is what resumes reads       */
        }
        a->reads_stopped = 0;                  /* Accelerator::SetYn2, DSPAccelerator.cpp:283 */
    }
    /* Non-looping: reads_stopped stays set, so every remaining fetch this frame returns 0 and
     * the cursor is parked at start. The caller clears pb->state. */
}

/* DSPAccelerator.cpp:117-231 — one decoded sample. */
static s16 accel_read(Accel *a) {
    if (a->reads_stopped) return 0;

    u32 step = 2;
    s16 raw, v;
    s32 v32, c1, c2;
    u8 gshift;

    if (FMT_DECODE(a->fmt) == 0) {              /* ---- DSP-ADPCM ---- */
        s32 scale;
        int ci;
        raw = (s16)(accel_fetch_raw(a) & 0xF);
        scale = 1 << (a->pred_scale & 0xF);
        ci = (a->pred_scale >> 4) & 7;
        c1 = a->coefs[ci * 2 + 0]; c2 = a->coefs[ci * 2 + 1];
        if (raw >= 8) raw -= 16;                /* sign-extend the nibble to [-8, +7] */

        /* The rounding constant is INSIDE the shifted sum, and the clamp low bound is
         * -0x7FFF, not -0x8000 (DSPAccelerator.cpp:152-156). */
        v32 = (scale * raw) + ((0x400 + c1 * a->yn1 + c2 * a->yn2) >> 11);
        v = (s16)(v32 > 0x7FFF ? 0x7FFF : (v32 < -0x7FFF ? -0x7FFF : v32));
        a->yn2 = a->yn1; a->yn1 = v;
        a->cur += 1;

        /* The header for the NEXT block is read here, AFTER the increment — Dolphin's order
         * (DSPAccelerator.cpp:159-185: increment, then this chain). Reading it before the
         * fetch instead produces the same nibble stream but shifts which call carries
         * step_size 4, which changes the end-of-sample comparison by one call at a block
         * boundary. Kept in Dolphin's order so loop points land identically.
         * The first two arms are block-aligned special cases that bypass the end exception
         * entirely — no exception, no pred_scale reload (DSPAccelerator.cpp:166-177). */
        if ((a->end & 0xF) == 0x0 && a->cur == a->end)          { a->cur = a->start + 1; }
        else if ((a->end & 0xF) == 0x1 && a->cur == a->end - 1) { a->cur = a->start; }
        else if ((a->cur & 15) == 0) {          /* block header byte = nibbles 0..1 of 16 */
            a->pred_scale = (u16)(aram_rd(a, (a->cur & ~15u) >> 1) & 0x7F);
            a->cur += 2;
            step += 2;
        }
        if (a->cur == a->end + step - 1) { a->cur = a->start; a->reads_stopped = 1; accel_end_exception(a); }
        return v;
    }

    /* ---- PCM8 / PCM16 (DSPAccelerator.cpp:187-219) ----
     * Gain applies ONLY here, never to ADPCM, and the coef/yn terms still run: PCM is not a
     * passthrough. There is no clamp on this path — Dolphin truncates to s16. */
    raw = accel_fetch_raw(a);
    gshift = (FMT_GAIN(a->fmt) == 0) ? 11 : (FMT_GAIN(a->fmt) == 1 ? 0 : 16);
    c1 = a->coefs[0]; c2 = a->coefs[1];
    v32 = (((s32)a->gain * raw) >> gshift)
        + (((c1 * a->yn1) >> gshift) + ((c2 * a->yn2) >> gshift));
    v = (s16)v32;
    a->yn2 = a->yn1; a->yn1 = v;
    if (FMT_DECODE(a->fmt) != 1) a->cur += 1;
    if (a->cur == a->end + step - 1) { a->cur = a->start; a->reads_stopped = 1; accel_end_exception(a); }
    return v;
}

/* ---- resampler (AXVoice.h:224-325) ------------------------------------------------------- */
/* Returns the updated 16.16 position. Polyphase (type 0) needs the DSP DROM coefficient table,
 * which this port has no dump of; Dolphin degrades it to linear in exactly the same case
 * (AXVoice.h:224 `if (coeffs)`), so type 0 and type 1 share the linear path here. */
static u32 resample(Accel *a, s16 *out, u32 count, s16 *last, u32 pos, u32 ratio, u16 type) {
    s16 t[4];
    u32 idx = 0, i;

    if (type == 2) {                            /* SRCTYPE_NEAREST: one read per output sample */
        for (i = 0; i < count; i++) out[i] = accel_read(a);
        if (count >= 4) memcpy(last, out + count - 4, 4 * sizeof(s16));
        return pos;
    }

    t[idx++ & 3] = last[0]; t[idx++ & 3] = last[1];
    t[idx++ & 3] = last[2]; t[idx++ & 3] = last[3];

    for (i = 0; i < count; i++) {
        pos += ratio;
        while (pos >= 0x10000) { t[idx++ & 3] = accel_read(a); pos -= 0x10000; }

        u16 frac = (u16)(pos & 0xFFFF);
        s16 s;
        if (frac) {
            /* u16 negation: inv = 0x10000 - frac, so the weights sum to exactly 0x10000. */
            u16 inv = (u16)(-(int)frac);
            s32 s0 = t[idx++ & 3];
            s32 s1 = t[idx++ & 3];
            s = (s16)(((s0 * (s32)inv) + (s1 * (s32)frac)) >> 16);
            idx += 2;
        } else {
            s = t[idx++ & 3];
            idx += 3;
        }
        /* Every branch advances idx by exactly 4, so the interpolator keeps a fixed 2-sample
         * group delay and reads the OLDEST two entries of the ring — copying that exactly
         * matters, it is not an off-by-one (AXVoice.h:261-316). */
        out[i] = s;
    }
    last[3] = t[--idx & 3]; last[2] = t[--idx & 3];
    last[1] = t[--idx & 3]; last[0] = t[--idx & 3];
    return pos;
}

/* ---- per-subframe PB updates (AXVoice.h:51-77) ------------------------------------------- */
/* patchData is 32 {u16 pbWordOffset; u16 newValue} pairs (salInitDspCtrl allocates 0x80 bytes,
 * hw_dspctrl.c:946-947 fills it). The offsets are WORD indices into _PB — confirmed against
 * hw_dspctrl.c:401 `pbOffsets[9] = {10,12,24,14,16,26,18,20,22}`, which are byte offsets
 * 0x14,0x18,0x30,0x1C,0x20,0x34,0x24,0x28,0x2C = precisely the nine mix volume-DELTA fields in
 * L,R,S,AuxAL,AuxAR,AuxAS,AuxBL,AuxBR,AuxBS order, and against :987-990 emitting 0x53/0x54 for
 * src.ratioHi/ratioLo (bytes 0xA6/0xA8). */
static void apply_updates(_PB *pb, const u16 *patch, int sub) {
    u32 start = 0, n, i;
    int k;
    u16 *pbw = (u16 *)pb;
    for (k = 0; k < sub; k++) start += pb->update.updNum[k];
    n = pb->update.updNum[sub];
    for (i = start; i < start + n && i < 32; i++) {
        u16 off = patch[i * 2 + 0];
        u16 val = patch[i * 2 + 1];
        if (off < sizeof(_PB) / 2) pbw[off] = val;
    }
}

/* ---- one voice into the accumulators ----------------------------------------------------- */

static void mix_voice(DSPvoice *dv, s32 *accL, s32 *accR) {
    _PB *pb = dv->pb;
    /* NOTE: do NOT skip on pb->state here. A voice started this frame with a non-zero
     * singleOffset is written state = 0 and is switched on by a PATCH UPDATE in subframe
     * `mix_start` (hw_dspctrl.c:727 sets it to 0, :950-951 emits the {word 7, value 1} update
     * that turns it on — word 7 is byte 0xE, which is `state`). Returning early on state == 0
     * would silently drop every such voice. The check belongs per-subframe, after the updates
     * are applied, which is also where Dolphin puts it (AXVoice.h:424-425). */
    if (!pb) return;

    const u8 *aram = (const u8 *)__recomp_aram_base();
    const u16 *patch = (const u16 *)dv->patchData;
    u32 ratio = HILO32(pb->src.ratioHi, pb->src.ratioLo);
    s16 buf[AX_SUBFRAME];
    int sub;
    u32 i, pos;
    Accel a;
    int ramp;
    u16 vL, dL, vR, dR;
    s32 *oL, *oR;

    for (sub = 0; sub < AX_SUBFRAMES; sub++) {
        if (patch) apply_updates(pb, patch, sub);
        /* `continue`, not `return`: the voice may be switched ON by a later subframe's update
         * as easily as retired by this one. */
        if (pb->state == 0) continue;

        /* Re-seed the accelerator from the PB every subframe, as the ucode does. */
        a.aram  = aram;
        a.start = HILO32(pb->addr.loopAddressHi,    pb->addr.loopAddressLo)    & 0x3FFFFFFFu;
        a.end   = HILO32(pb->addr.endAddressHi,     pb->addr.endAddressLo)     & 0x3FFFFFFFu;
        a.cur   = HILO32(pb->addr.currentAddressHi, pb->addr.currentAddressLo) & 0xBFFFFFFFu;
        a.fmt   = pb->addr.format;
        a.yn1   = (s16)pb->adpcm.yn1;
        a.yn2   = (s16)pb->adpcm.yn2;
        a.gain  = (s16)pb->adpcm.gain;
        a.pred_scale = pb->adpcm.pred_scale & 0x7F;
        a.reads_stopped = 0;
        a.looping   = pb->addr.loopFlag != 0;
        a.is_stream = pb->loopType == 1;    /* compType 4/5, hw_dspctrl.c:598 */
        a.loop_ps   = pb->adpcmLoop.loop_pred_scale;
        a.loop_yn1  = (s16)pb->adpcmLoop.loop_yn1;
        a.loop_yn2  = (s16)pb->adpcmLoop.loop_yn2;
        a.coefs     = (const s16 *)&pb->adpcm.a[0][0];

        pos = resample(&a, buf, AX_SUBFRAME, (s16 *)pb->src.last_samples,
                           pb->src.currentAddressFrac, ratio, pb->srcSelect);

        pb->src.currentAddressFrac = (u16)(pos & 0xFFFF);
        pb->addr.currentAddressHi  = (u16)(a.cur >> 16);
        pb->addr.currentAddressLo  = (u16)a.cur;
        pb->adpcm.yn1 = (u16)a.yn1;
        pb->adpcm.yn2 = (u16)a.yn2;
        pb->adpcm.pred_scale = a.pred_scale;

        /* A non-looping voice that hit its end stalls the accelerator and is done. */
        if (a.reads_stopped && !a.looping) pb->state = 0;

        /* Volume envelope, AXVoice.h:432-445. Q15, and on GameCube cur_volume is read SIGNED. */
        for (i = 0; i < AX_SUBFRAME; i++) {
            s32 vol = (s16)pb->ve.currentVolume;
            buf[i] = (s16)clamp_s16(((s32)buf[i] * vol) >> 15);
            pb->ve.currentVolume = (u16)(pb->ve.currentVolume + pb->ve.currentDelta);
        }

        /* Main L/R mix ramps, AXVoice.h:358-381. Here the volume IS unsigned, so 0x8000 is
         * unity. The per-voice product is clamped to s16 BEFORE accumulation — the 32-bit
         * buffer only accumulates ACROSS voices, never within one. */
        ramp = (pb->mixerCtrl & 0x08) != 0;
        vL = pb->mix.vL; dL = ramp ? pb->mix.vDeltaL : 0;
        vR = pb->mix.vR; dR = ramp ? pb->mix.vDeltaR : 0;
        oL = accL + sub * AX_SUBFRAME; oR = accR + sub * AX_SUBFRAME;
        for (i = 0; i < AX_SUBFRAME; i++) {
            oL[i] += clamp_s16(((s32)buf[i] * (s32)vL) >> 15);
            oR[i] += clamp_s16(((s32)buf[i] * (s32)vR) >> 15);
            vL = (u16)(vL + dL);
            vR = (u16)(vR + dR);
        }
        pb->mix.vL = vL;
        pb->mix.vR = vR;
    }
}

/* ---- the frame -------------------------------------------------------------------------- */
/* Called from salCtrlDsp (gc_musyx_hw.c) in place of mailing the command list to the DSP.
 * salBuildCommandList has already run, so every _PB carries this frame's addresses, envelope,
 * ramps and patch list; what remains is exactly the work the ucode would have done. */
/* Peaks recorded HERE rather than by the host, because the host can only sample at its own
 * 60 Hz pump while this runs at the AI's 200 Hz — and a sound effect can begin and end between
 * two host samples, which would read as "no voice ever played" when one did. */
static s32 peak_pb_playing, peak_voicemgr_busy, peak_mixed_nonzero;
s32 __recomp_musyx_stat(s32 which);

void __recomp_musyx_mix(s16 *dest) {
    static s32 accL[AX_FRAME_SAMPLES], accR[AX_FRAME_SAMPLES];
    u32 fi;
    s32 nplay = 0, nbusy = 0;
    u32 vi;
    if (!dest) return;
    if (dspVoice) {
        for (vi = 0; vi < salNumVoices; vi++) {
            if (dspVoice[vi].state) nbusy++;
            if (dspVoice[vi].pb && dspVoice[vi].pb->state) nplay++;
        }
    }
    if (nplay > peak_pb_playing)   peak_pb_playing = nplay;
    if (nbusy > peak_voicemgr_busy) peak_voicemgr_busy = nbusy;
    memset(accL, 0, sizeof(accL));
    memset(accR, 0, sizeof(accR));

    if (dspVoice) {
        u8 st;
        DSPvoice *dv;
        for (st = 0; st < salMaxStudioNum; st++) {
            if (dspStudio[st].state != 1) continue;
            for (dv = dspStudio[st].voiceRoot; dv; dv = dv->next) mix_voice(dv, accL, accR);
        }
    }

    /* AX.cpp:611-630: clamp the accumulator straight to s16, no post-mix shift. Dolphin writes
     * right-then-left because it byteswaps for the GameCube's own buffer; this port hands the
     * result to a little-endian Web Audio ring, so it is written L,R interleaved. */
    for (fi = 0; fi < AX_FRAME_SAMPLES; fi++) {
        dest[fi * 2 + 0] = (s16)clamp_s16(accL[fi]);
        dest[fi * 2 + 1] = (s16)clamp_s16(accR[fi]);
        if (accL[fi] || accR[fi]) peak_mixed_nonzero++;
    }
}

/* Attribution counters. "Silent" has several very different causes and they are not
 * distinguishable from the output alone, so each stage reports itself:
 *   0 salNumVoices     — did salInitDspCtrl run at all
 *   1 active studios   — a voice only reaches the mix through a studio in state 1
 *   2 dspVoice[] busy  — voices the VOICE MANAGER thinks are playing (dv->state != 0),
 *                        independent of any studio list
 *   3 PBs with state   — voices the MIXER would actually render
 *   4 voiceRoot linked — voices reachable from an active studio's list
 * If 2 is non-zero while 3/4 are zero, the engine is playing and the mix path is not seeing it;
 * if 2 is zero, nothing has been triggered yet and the mixer is not the problem. */
s32 __recomp_musyx_stat(s32 which) {
    s32 n = 0;
    u8 st;
    u32 v;
    DSPvoice *dv;
    switch (which) {
    case 0: return salNumVoices;
    case 1:
        for (st = 0; st < salMaxStudioNum; st++) if (dspStudio[st].state == 1) n++;
        return n;
    case 2:
        if (!dspVoice) return -1;
        for (v = 0; v < salNumVoices; v++) if (dspVoice[v].state) n++;
        return n;
    case 3:
        if (!dspVoice) return -1;
        for (v = 0; v < salNumVoices; v++) if (dspVoice[v].pb && dspVoice[v].pb->state) n++;
        return n;
    case 4:
        for (st = 0; st < salMaxStudioNum; st++)
            for (dv = dspStudio[st].voiceRoot; dv; dv = dv->next) n++;
        return n;
    /* Peaks sampled at the AI rate inside the mixer, not at the host's pump rate. */
    case 5: return peak_voicemgr_busy;
    case 6: return peak_pb_playing;
    case 7: return peak_mixed_nonzero;
    default: return 0;
    }
}

/* Diagnostic: how many voices were actually playing on the last frame, so "silent" can be
 * attributed to "no voices" vs "voices but no signal". */
s32 __recomp_musyx_active_voices(void) {
    s32 n = 0;
    u8 st;
    DSPvoice *dv;
    if (!dspVoice) return 0;
    for (st = 0; st < salMaxStudioNum; st++) {
        if (dspStudio[st].state != 1) continue;
        for (dv = dspStudio[st].voiceRoot; dv; dv = dv->next)
            if (dv->pb && dv->pb->state) n++;
    }
    return n;
}
