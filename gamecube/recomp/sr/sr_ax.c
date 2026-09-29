// sr_ax.c — the AX DSP ucode's COMMAND LIST, HLE'd the way Dolphin's default configuration
// (MAIN_DSP_HLE) HLEs it, for the SAB whole-image boot (build_image.sh, -DSR_MMIO).
//
// WHY THIS EXISTS.  README §10.6: with the DSP interface, the boot ROM ucode and AX's mail
// protocol modelled, the whole image's first strict stop is SR_F_DSP_AXCMD — the AI-DMA
// callback hands the AX ucode (HashEctor 0x4e8a8b21, UCodes.cpp:156) its first command list at
// 6 M guest cycles.  The DSP's answer is not just a mail: it READS voice parameter blocks
// (PBs) out of MEM1, walks ARAM samples through the accelerator, WRITES the PBs back (current
// address, ADPCM history, `running` cleared at a one-shot's end, loop counter) and uploads mixed
// buffers the CPU reads (the AUX callbacks run on the CPU — README §8.6e's HandleReverb is one).
// So "acknowledge the frame without doing it" would hand the guest state no DSP ever produced,
// and the no-approximation rule forbids it.
//
// WHAT IT IS.  A C transcription of ~/dolphin-upstream (0cd3bb89c2)
//   Source/Core/Core/HW/DSPHLE/UCodes/AX.cpp      HandleCommandList + the command bodies
//   Source/Core/Core/HW/DSPHLE/UCodes/AXVoice.h   ProcessVoice and what it calls (AX_GC arm)
//   Source/Core/Core/HW/DSPHLE/UCodes/AXStructs.h the AXPB layout
//   Source/Core/Core/DSP/DSPAccelerator.cpp      ReadSample / GetCurrentSample
// for the ONE ucode SAB boots, 0x4e8a8b21, and only it: that ucode's PB has no low-pass-filter
// words in memory (AX.cpp HasLpf, ReadPB/WritePB), and ConvertMixerControl has a branch for it.
// Anything the reference would handle differently for another CRC is not reachable here.
//
// THE REFERENCE, NOT THE HARDWARE.  Dolphin's HLE is itself an approximation of the real ucode;
// in particular with no dsp_coef.bin present (it is not shipped) it resamples LINEARLY where the
// hardware uses the polyphase DROM table (AXVoice.h ResampleAudio; AX.cpp
// LoadResamplingCoefficients).  This file reproduces the reference configuration — the same one
// docs/ORACLES.md's native Dolphin runs — and claims nothing beyond it.
//
// NOT PRODUCED: sound.  OutputSamples writes the clamped L/R frame to MEM1 exactly as the
// reference does; nothing here plays it.
#include <stdint.h>
#include <string.h>
#include <emscripten.h>
#include "gekko_rt.h"

extern uint8_t  *g_ram;
extern uint32_t  g_ram_size;
extern uint32_t  g_fault;
uint8_t *sr_image_aram_ptr(void);          // sr_image.c: the 16 MB ARAM the DMA model fills

#define SR_F_AX_RANGE   0xC6D00000u        // a command list / PB / buffer address outside MEM1
#define SR_F_AX_CMD     0xC6D10000u        // a command the reference asserts cannot occur here
#define ARAM_MASK       0x00FFFFFFu

// ------------------------------------------------------------------ guest memory, big-endian
static int ax_ok(uint32_t a, uint32_t n) {
    uint32_t p = a & 0x3FFFFFFFu;             // Memory::GetPointerForRange: physical view
    if (p + n > g_ram_size) { if (!g_fault) g_fault = SR_F_AX_RANGE | ((a >> 16) & 0xFFFFu); return 0; }
    return 1;
}
static uint8_t *ax_p(uint32_t a) { return g_ram + (a & 0x3FFFFFFFu); }
static uint16_t rd16(uint32_t a) { uint8_t *p = ax_p(a); return (uint16_t)((p[0] << 8) | p[1]); }
static uint32_t rd32(uint32_t a) { uint8_t *p = ax_p(a); return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static void wr16(uint32_t a, uint16_t v) { uint8_t *p = ax_p(a); p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void wr32(uint32_t a, uint32_t v) { uint8_t *p = ax_p(a); p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16); p[2] = (uint8_t)(v >> 8); p[3] = (uint8_t)v; }

static int16_t clamp16(int64_t s) { return (int16_t)(s < -0x8000 ? -0x8000 : s > 0x7FFF ? 0x7FFF : s); }

// ------------------------------------------------------------------ AXPB (AXStructs.h:200-224)
// The struct as Dolphin holds it, one u16 per slot, WITH the four lpf words (93..96).  The
// guest's memory image of it for 0x4e8a8b21 has no lpf words (AX.cpp ReadPB/WritePB skip them),
// which is why the PB is 118 u16 in memory and 122 here.
#define PB_WORDS      122
#define PB_MEM_WORDS  118
#define PB_LPF_OFF    93
#define PB_LC_OFF     97
enum {
    PB_NEXT_HI = 0, PB_NEXT_LO, PB_THIS_HI, PB_THIS_LO, PB_SRC_TYPE, PB_COEF_SELECT,
    PB_MIXER_CONTROL, PB_RUNNING, PB_IS_STREAM,
    PB_MIXER = 9,           // 9 x VolumeData {volume, delta}: mL mR aL aR bL bR bS mS aS
    PB_ITD = 27,            // initial_time_delay.on
    PB_UPD_NUM = 34,        // updates.num_updates[5]
    PB_UPD_HI = 39, PB_UPD_LO = 40,
    PB_DPOP = 41,           // mL aL bL mR aR bR mS aS bS
    PB_VOL_CUR = 50, PB_VOL_DELTA = 51,
    PB_AA_LOOPING = 55, PB_AA_FORMAT, PB_AA_LOOP_HI, PB_AA_LOOP_LO, PB_AA_END_HI, PB_AA_END_LO,
    PB_AA_CUR_HI, PB_AA_CUR_LO,
    PB_ADPCM_COEFS = 63, PB_ADPCM_GAIN = 79, PB_ADPCM_PS = 80, PB_ADPCM_YN1 = 81, PB_ADPCM_YN2 = 82,
    PB_SRC_RATIO_HI = 83, PB_SRC_RATIO_LO = 84, PB_SRC_FRAC = 85, PB_SRC_LAST = 86,
    PB_LOOP_PS = 90, PB_LOOP_YN1 = 91, PB_LOOP_YN2 = 92,
    PB_LPF_ON = 93, PB_LPF_YN1 = 94, PB_LPF_A0 = 95, PB_LPF_B0 = 96,
    PB_LOOP_COUNTER = 97,
};

static void read_pb(uint32_t addr, uint16_t *pb) {          // AX.cpp:415-436, no-lpf arm
    for (int i = 0; i < PB_LPF_OFF; i++) pb[i] = rd16(addr + 2u * i);
    for (int i = PB_LPF_OFF; i < PB_LC_OFF; i++) pb[i] = 0;
    for (int i = PB_LC_OFF; i < PB_WORDS; i++) pb[i] = rd16(addr + 2u * (i - 4));
}
static void write_pb(uint32_t addr, const uint16_t *pb) {   // AX.cpp:438-456, no-lpf arm
    for (int i = 0; i < PB_LPF_OFF; i++) wr16(addr + 2u * i, pb[i]);
    for (int i = PB_LC_OFF; i < PB_WORDS; i++) wr16(addr + 2u * (i - 4), pb[i]);
}

// ------------------------------------------------------------------ the mixing buffers
static int32_t s_main_l[160], s_main_r[160], s_main_s[160];
static int32_t s_auxa_l[160], s_auxa_r[160], s_auxa_s[160];
static int32_t s_auxb_l[160], s_auxb_r[160], s_auxb_s[160];
static uint16_t s_cmdlist[512];
static uint32_t s_compressor_pos = 0;
static uint32_t s_pbs = 0, s_lists = 0, s_voices_run = 0, s_unknown_cmds = 0;

// ------------------------------------------------------------------ the accelerator
// DSPAccelerator.cpp, the state HLEAccelerator carries and the two reads ProcessVoice uses.
static struct {
    uint32_t start, end, cur;
    uint16_t fmt, pred_scale, input;
    int16_t  gain, yn1, yn2;
    int      reads_stopped;
    uint16_t *pb;                    // HLEAccelerator::acc_pb
} A;
static uint8_t aram_rd(uint32_t a) { return sr_image_aram_ptr()[a & ARAM_MASK]; }  // DSP.cpp:575-593
static void acc_set_cur(uint32_t a) { A.cur = a & 0xBFFFFFFFu; }
static void acc_set_yn2(int16_t v) { A.yn2 = v; A.reads_stopped = 0; }
static uint16_t acc_current_sample(void) {                  // DSPAccelerator.cpp GetCurrentSample
    uint16_t val = 0;
    switch (A.fmt & 3) {
    case 0: val = aram_rd(A.cur >> 1); if (A.cur & 1) val &= 0xF; else val >>= 4; break;
    case 1: val = aram_rd(A.cur); break;
    case 2: val = (uint16_t)((aram_rd(A.cur * 2) << 8) | aram_rd(A.cur * 2 + 1)); break;
    default: break;                  // "produces garbage, but affects the current address"
    }
    return val;
}
// AXVoice.h OnSampleReadEndException (AX_GC arm).
static void acc_end_exception(void) {
    uint16_t *pb = A.pb;
    if (pb[PB_AA_LOOPING]) {
        A.pred_scale = pb[PB_LOOP_PS] & 0x7F;
        if (pb[PB_IS_STREAM] != 1) {
            A.yn1 = (int16_t)pb[PB_LOOP_YN1];
            acc_set_yn2((int16_t)pb[PB_LOOP_YN2]);
        } else {
            acc_set_yn2(A.yn2);      // SetYn1(GetYn1()); SetYn2(GetYn2())
            pb[PB_LOOP_COUNTER]++;
        }
    } else {
        pb[PB_RUNNING] = 0;
    }
}
static uint16_t acc_read_sample(const int16_t *coefs) {     // DSPAccelerator.cpp ReadSample
    if (A.reads_stopped) return 0;
    uint16_t val = 0;
    uint32_t step = 0;
    uint32_t decode = (A.fmt >> 2) & 3, gscale = (A.fmt >> 4) & 3;
    int16_t raw = (decode == 1 || decode == 3) ? (int16_t)A.input : (int16_t)acc_current_sample();
    int ci = (A.pred_scale >> 4) & 7;
    int32_t c1 = coefs[ci * 2], c2 = coefs[ci * 2 + 1];
    if (decode == 0) {                                          // ADPCM
        raw &= 0xF;
        int scale = 1 << (A.pred_scale & 0xF);
        if (raw >= 8) raw -= 16;
        int32_t v = (scale * raw) + ((0x400 + c1 * A.yn1 + c2 * A.yn2) >> 11);
        val = (uint16_t)(int16_t)(v < -0x7FFF ? -0x7FFF : v > 0x7FFF ? 0x7FFF : v);
        step = 2;
        A.yn2 = A.yn1; A.yn1 = (int16_t)val;
        A.cur += 1;
        if ((A.end & 0xF) == 0x0 && A.cur == A.end)               A.cur = A.start + 1;
        else if ((A.end & 0xF) == 0x1 && A.cur == A.end - 1)      A.cur = A.start;
        else if ((A.cur & 15) == 0) {
            A.pred_scale = aram_rd((A.cur & ~15u) >> 1);
            A.cur += 2; step += 2;
        }
    } else {                                                    // PCM / MMIO PCM
        int sh = 0;
        if (gscale == 0) sh = 11; else if (gscale == 1) sh = 0; else if (gscale == 2) sh = 16;
        int32_t v = (((int32_t)A.gain * raw) >> sh) + (((c1 * A.yn1) >> sh) + ((c2 * A.yn2) >> sh));
        val = (uint16_t)(int16_t)v;
        A.yn2 = A.yn1; A.yn1 = (int16_t)val;
        step = 2;
        if (decode != 1) A.cur += 1;
    }
    if (A.cur == A.end + step - 1) {
        A.cur = A.start;
        A.reads_stopped = 1;
        acc_end_exception();
    }
    acc_set_cur(A.cur);
    return val;
}

// ------------------------------------------------------------------ AXVoice.h, AX_GC arm
static void accel_setup(uint16_t *pb) {                    // AcceleratorSetup
    A.pb = pb;
    A.start = (((uint32_t)pb[PB_AA_LOOP_HI] << 16) | pb[PB_AA_LOOP_LO]) & 0x3FFFFFFFu;
    A.end   = (((uint32_t)pb[PB_AA_END_HI] << 16)  | pb[PB_AA_END_LO])  & 0x3FFFFFFFu;
    acc_set_cur(((uint32_t)pb[PB_AA_CUR_HI] << 16) | pb[PB_AA_CUR_LO]);
    A.fmt = pb[PB_AA_FORMAT];
    A.yn1 = (int16_t)pb[PB_ADPCM_YN1];
    acc_set_yn2((int16_t)pb[PB_ADPCM_YN2]);
    A.gain = (int16_t)pb[PB_ADPCM_GAIN];
    A.pred_scale = pb[PB_ADPCM_PS] & 0x7F;
}
// ResampleAudio with coeffs == nullptr (no dsp_coef.bin): POLYPHASE falls through to LINEAR.
static uint32_t resample(int16_t *out, uint32_t count, int16_t *last, uint32_t pos,
                         uint32_t ratio, int srctype, const int16_t *coefs) {
    if (srctype == 0 || srctype == 1) {
        int16_t t[4]; uint32_t idx = 0;
        t[idx++ & 3] = last[0]; t[idx++ & 3] = last[1]; t[idx++ & 3] = last[2]; t[idx++ & 3] = last[3];
        for (uint32_t i = 0; i < count; i++) {
            pos += ratio;
            while (pos >= 0x10000) { t[idx++ & 3] = (int16_t)acc_read_sample(coefs); pos -= 0x10000; }
            uint16_t frac = (uint16_t)(pos & 0xFFFF), inv = (uint16_t)-frac;
            int16_t s;
            if (frac) {
                int32_t s0 = t[idx++ & 3], s1 = t[idx++ & 3];
                s = (int16_t)(((s0 * inv) + (s1 * frac)) >> 16);
                idx += 2;
            } else { s = t[idx++ & 3]; idx += 3; }
            out[i] = s;
        }
        last[3] = t[--idx & 3]; last[2] = t[--idx & 3]; last[1] = t[--idx & 3]; last[0] = t[--idx & 3];
    } else {                                                    // SRCTYPE_NEAREST
        for (uint32_t i = 0; i < count; i++) out[i] = (int16_t)acc_read_sample(coefs);
        memcpy(last, out + count - 4, 4 * sizeof(int16_t));
    }
    return pos;
}
static void mix_add(int32_t *out, const int16_t *in, uint32_t count, uint16_t *vd, int16_t *dpop, int ramp) {
    uint16_t delta = ramp ? vd[1] : 0;                       // MixAdd
    for (uint32_t i = 0; i < count; i++) {
        int64_t s = in[i]; s *= vd[0]; s >>= 15;
        int16_t s16 = clamp16((int32_t)s);
        out[i] += s16;
        vd[0] = (uint16_t)(vd[0] + delta);
        *dpop = s16;
    }
}
// AX.cpp ConvertMixerControl, the 0x4e8a8b21 branch.
#define MIX_MAIN_L 0x000001
#define MIX_MAIN_R 0x000004
#define MIX_MAIN_S 0x000010
#define MIX_AUXA_L 0x000040
#define MIX_AUXA_R 0x000100
#define MIX_AUXA_S 0x000400
#define MIX_AUXB_L 0x001000
#define MIX_AUXB_R 0x004000
#define MIX_AUXB_S 0x010000
#define MIX_ALL_RAMPS 0xAAAAAA
static uint32_t mixer_control(uint32_t mc) {
    uint32_t r = 0;
    if (mc & 0x0010) {
        r |= MIX_MAIN_L | MIX_MAIN_R;
        if ((mc & 0x0006) == 0) r |= MIX_AUXB_L | MIX_AUXB_R;
        if ((mc & 0x0007) == 1) r |= MIX_AUXA_L | MIX_AUXA_R | MIX_AUXA_S;
    } else {
        r |= MIX_MAIN_L | MIX_MAIN_R;
        if (mc & 0x0001) r |= MIX_AUXA_L | MIX_AUXA_R;
        if (mc & 0x0002) r |= MIX_AUXB_L | MIX_AUXB_R;
        if (mc & 0x0004) {
            r |= MIX_MAIN_S;
            if (r & MIX_AUXA_L) r |= MIX_AUXA_S;
            if (r & MIX_AUXB_L) r |= MIX_AUXB_S;
        }
    }
    if (mc & 0x0008) r |= MIX_ALL_RAMPS;
    return r;
}
static void process_voice(uint16_t *pb, int32_t *const *buf, uint32_t count, uint32_t mctrl) {
    if (pb[PB_RUNNING] != 1) return;
    int16_t samples[32];
    accel_setup(pb);                                         // GetInputSamples
    int16_t last[4]; for (int i = 0; i < 4; i++) last[i] = (int16_t)pb[PB_SRC_LAST + i];
    uint32_t pos = resample(samples, count, last, pb[PB_SRC_FRAC],
                            ((uint32_t)pb[PB_SRC_RATIO_HI] << 16) | pb[PB_SRC_RATIO_LO],
                            pb[PB_SRC_TYPE], (const int16_t *)&pb[PB_ADPCM_COEFS]);
    for (int i = 0; i < 4; i++) pb[PB_SRC_LAST + i] = (uint16_t)last[i];
    pb[PB_SRC_FRAC] = (uint16_t)(pos & 0xFFFF);
    pb[PB_AA_CUR_HI] = (uint16_t)(A.cur >> 16);
    pb[PB_AA_CUR_LO] = (uint16_t)A.cur;
    pb[PB_ADPCM_YN1] = (uint16_t)A.yn1;
    pb[PB_ADPCM_YN2] = (uint16_t)A.yn2;
    pb[PB_ADPCM_PS]  = A.pred_scale;
    s_voices_run++;
    for (uint32_t i = 0; i < count; i++) {                   // volume envelope, signed on GC
        int32_t vol = (int16_t)pb[PB_VOL_CUR];
        samples[i] = clamp16(((int32_t)samples[i] * vol) >> 15);
        pb[PB_VOL_CUR] = (uint16_t)(pb[PB_VOL_CUR] + pb[PB_VOL_DELTA]);
    }
    if (pb[PB_LPF_ON] != 0) {                                // unreachable for 0x4e8a8b21 (zeroed)
        int16_t yn1 = (int16_t)pb[PB_LPF_YN1];
        for (uint32_t i = 0; i < count; i++)
            yn1 = samples[i] = clamp16(((int32_t)(uint16_t)pb[PB_LPF_A0] * samples[i] +
                                        (int32_t)(int16_t)pb[PB_LPF_B0] * yn1) >> 15);
        pb[PB_LPF_YN1] = (uint16_t)yn1;
    }
    // mixer VolumeData order mL mR aL aR bL bR bS mS aS; dpop order mL aL bL mR aR bR mS aS bS
    struct { uint32_t on, ramp; int b; int vd; int dp; } m[9] = {
        { MIX_MAIN_L, 0x000002, 0, 0, 0 }, { MIX_MAIN_R, 0x000008, 1, 1, 3 },
        { MIX_MAIN_S, 0x000020, 2, 7, 6 }, { MIX_AUXA_L, 0x000080, 3, 2, 1 },
        { MIX_AUXA_R, 0x000200, 4, 3, 4 }, { MIX_AUXA_S, 0x000800, 5, 8, 7 },
        { MIX_AUXB_L, 0x002000, 6, 4, 2 }, { MIX_AUXB_R, 0x008000, 7, 5, 5 },
        { MIX_AUXB_S, 0x020000, 8, 6, 8 } };
    for (int k = 0; k < 9; k++)
        if (mctrl & m[k].on)
            mix_add(buf[m[k].b], samples, count, &pb[PB_MIXER + 2 * m[k].vd],
                    (int16_t *)&pb[PB_DPOP + m[k].dp], (mctrl & m[k].ramp) != 0);
    // initial_time_delay.on: "TODO" in the reference too — nothing is done with it.
}

// ------------------------------------------------------------------ AX.cpp command bodies
static void setup_processing(uint32_t a) {                  // SetupProcessing / InitMixingBuffers<5>
    int32_t *b[9] = { s_main_l, s_main_r, s_main_s, s_auxa_l, s_auxa_r, s_auxa_s, s_auxb_l, s_auxb_r, s_auxb_s };
    if (!ax_ok(a, 9 * 6)) return;
    for (int i = 0; i < 9; i++) {
        int32_t value = (int32_t)(((uint32_t)rd16(a + 6u * i) << 16) | rd16(a + 6u * i + 2));
        int16_t delta = (int16_t)rd16(a + 6u * i + 4);
        if (value == 0) memset(b[i], 0, 160 * sizeof(int32_t));
        else for (int j = 0; j < 160; j++) b[i][j] = value + j * delta;
    }
}
static void dl_and_vol_mix(uint32_t a, uint16_t vm, uint16_t va, uint16_t vb) {
    int32_t *b[3][3] = { { s_main_l, s_main_r, s_main_s }, { s_auxa_l, s_auxa_r, s_auxa_s },
                         { s_auxb_l, s_auxb_r, s_auxb_s } };
    uint16_t vol[3] = { vm, va, vb };
    if (!ax_ok(a, 3 * 5 * 32 * 4)) return;
    for (int i = 0; i < 3; i++) {                            // NB: the reference re-reads the SAME
        uint32_t p = a;                                      // 3 buffers for each of main/auxa/auxb
        for (int j = 0; j < 3; j++)
            for (int k = 0; k < 160; k++, p += 4) {
                int64_t s = (int64_t)(int32_t)rd32(p);
                s *= vol[i];
                b[i][j][k] += (int32_t)(s >> 15);
            }
    }
}
static void process_pb_list(uint32_t pb_addr) {            // AX.cpp:458-493
    uint16_t pb[PB_WORDS];
    while (pb_addr) {
        if (!ax_ok(pb_addr, PB_MEM_WORDS * 2)) return;
        int32_t *buf[9] = { s_main_l, s_main_r, s_main_s, s_auxa_l, s_auxa_r, s_auxa_s, s_auxb_l, s_auxb_r, s_auxb_s };
        read_pb(pb_addr, pb);
        uint32_t ua = ((uint32_t)pb[PB_UPD_HI] << 16) | pb[PB_UPD_LO];
        uint16_t upd[64];                                    // LoadPBUpdates: 32 x {offset, value}
        if (!ax_ok(ua, sizeof upd)) return;
        for (int i = 0; i < 64; i++) upd[i] = rd16(ua + 2u * i);
        for (int ms = 0; ms < 5; ms++) {
            uint32_t start = 0;                              // ApplyUpdatesForMs
            for (int i = 0; i < ms; i++) start += pb[PB_UPD_NUM + i];
            for (uint32_t i = start; i < start + pb[PB_UPD_NUM + ms]; i++) {
                if (i >= 32 || upd[2 * i] >= PB_WORDS) {     // outside std::array / the struct:
                    if (!g_fault) g_fault = SR_F_AX_CMD | 0xFE00u;   // UB in the reference; raise
                    return;
                }
                pb[upd[2 * i]] = upd[2 * i + 1];
            }
            process_voice(pb, buf, 32, mixer_control(pb[PB_MIXER_CONTROL]));
            for (int k = 0; k < 9; k++) buf[k] += 32;
        }
        write_pb(pb_addr, pb);
        s_pbs++;
        pb_addr = ((uint32_t)pb[PB_NEXT_HI] << 16) | pb[PB_NEXT_LO];
    }
}
static void upload3(uint32_t a, int32_t *x, int32_t *y, int32_t *z) {
    int32_t *b[3] = { x, y, z };
    if (!ax_ok(a, 3 * 640)) return;
    for (int i = 0; i < 3; i++) for (int k = 0; k < 160; k++, a += 4) wr32(a, (uint32_t)b[i][k]);
}
static void mix_aux(int aux, uint32_t wa, uint32_t ra) {    // MixAUXSamples
    int32_t *b[3] = { aux ? s_auxb_l : s_auxa_l, aux ? s_auxb_r : s_auxa_r, aux ? s_auxb_s : s_auxa_s };
    if (wa) upload3(wa, b[0], b[1], b[2]);
    if (!ax_ok(ra, 3 * 640)) return;
    for (int k = 0; k < 160; k++, ra += 4) s_main_l[k] += (int32_t)rd32(ra);
    for (int k = 0; k < 160; k++, ra += 4) s_main_r[k] += (int32_t)rd32(ra);
    for (int k = 0; k < 160; k++, ra += 4) s_main_s[k] += (int32_t)rd32(ra);
}
static void set_main_lr(uint32_t a) {
    if (!ax_ok(a, 640)) return;
    for (int k = 0; k < 160; k++, a += 4) { int32_t s = (int32_t)rd32(a); s_main_l[k] = s; s_main_r[k] = s; s_main_s[k] = 0; }
}
static void output_samples(uint32_t lr, uint32_t surround) { // OutputSamples
    if (!ax_ok(surround, 640) || !ax_ok(lr, 640)) return;
    for (int k = 0; k < 160; k++) wr32(surround + 4u * k, (uint32_t)s_main_s[k]);
    for (int k = 0; k < 160; k++) {                          // R then L, each big-endian s16
        wr16(lr + 4u * k,     (uint16_t)clamp16(s_main_r[k]));
        wr16(lr + 4u * k + 2, (uint16_t)clamp16(s_main_l[k]));
    }
}
static void mix_auxb_lr(uint32_t ul, uint32_t dl) {
    if (!ax_ok(ul, 1280) || !ax_ok(dl, 1280)) return;
    for (int k = 0; k < 160; k++) wr32(ul + 4u * k, (uint32_t)s_auxb_l[k]);
    for (int k = 0; k < 160; k++) wr32(ul + 640u + 4u * k, (uint32_t)s_auxb_r[k]);
    for (int k = 0; k < 160; k++, dl += 4) { int32_t s = (int32_t)rd32(dl); s_auxb_l[k] = s; s_main_l[k] += s; }
    for (int k = 0; k < 160; k++, dl += 4) { int32_t s = (int32_t)rd32(dl); s_auxb_r[k] = s; s_main_r[k] += s; }
}
static void set_opposite_lr(uint32_t a) {
    if (!ax_ok(a, 640)) return;
    for (int k = 0; k < 160; k++, a += 4) { int32_t s = (int32_t)rd32(a); s_main_l[k] = -s; s_main_r[k] = s; s_main_s[k] = 0; }
}
static void send_aux_and_mix(uint32_t aup, uint32_t bsup, uint32_t ml, uint32_t mr, uint32_t bl, uint32_t br) {
    upload3(aup, s_auxa_l, s_auxa_r, s_auxa_s);
    if (!ax_ok(bsup, 640)) return;
    for (int k = 0; k < 160; k++) wr32(bsup + 4u * k, (uint32_t)s_auxb_s[k]);
    int32_t *d[4] = { s_main_l, s_main_r, s_auxb_l, s_auxb_r };
    uint32_t a[4] = { ml, mr, bl, br };
    for (int i = 0; i < 4; i++) {
        if (!ax_ok(a[i], 640)) return;
        for (int k = 0; k < 160; k++) d[i][k] += (int32_t)rd32(a[i] + 4u * k);
    }
}
static int copy_cmdlist(uint32_t a, uint16_t size) {        // CopyCmdList
    if (size >= 512) return 0;                               // ERROR_LOG and return
    if (!ax_ok(a, size * 2u)) return 0;
    for (uint32_t i = 0; i < size; i++) s_cmdlist[i] = rd16(a + 2u * i);
    return 1;
}

// AX.cpp:113-360 HandleCommandList.  Returns 0 normally; the caller signals work end.
#define HL(h, l) (((uint32_t)(h) << 16) | (l))
EMSCRIPTEN_KEEPALIVE uint32_t sr_ax_pbs(void)          { return s_pbs; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_ax_lists(void)        { return s_lists; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_ax_voices(void)       { return s_voices_run; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_ax_unknown_cmds(void) { return s_unknown_cmds; }
void sr_ax_command_list(uint32_t addr, uint16_t size) {
    copy_cmdlist(addr, size);
    s_lists++;
    uint32_t pb_addr = 0, i = 0;
    for (int end = 0; !end && !g_fault; ) {
        if (i >= 512) { if (!g_fault) g_fault = SR_F_AX_CMD | 0xFF00u; return; }
        uint16_t cmd = s_cmdlist[i++];
        uint16_t *c = &s_cmdlist[i];
        switch (cmd) {
        case 0x00: setup_processing(HL(c[0], c[1])); i += 2; break;
        case 0x01: dl_and_vol_mix(HL(c[0], c[1]), c[2], c[3], c[4]); i += 5; break;
        case 0x02: pb_addr = HL(c[0], c[1]); i += 2; break;
        case 0x03: process_pb_list(pb_addr); break;
        case 0x04: case 0x05: mix_aux(cmd - 0x04, HL(c[0], c[1]), HL(c[2], c[3])); i += 4; break;
        case 0x06: upload3(HL(c[0], c[1]), s_main_l, s_main_r, s_main_s); i += 2; break;
        case 0x07: set_main_lr(HL(c[0], c[1])); i += 2; break;
        case 0x08: s_unknown_cmds++; i += 10; break;         // "TODO: check" in the reference
        case 0x09: mix_aux(1, 0, HL(c[0], c[1])); i += 2; break;
        case 0x0A: case 0x0B: case 0x0C: break;
        case 0x0D: { uint32_t a = HL(c[0], c[1]); uint16_t sz = c[2]; copy_cmdlist(a, sz); i = 0; break; }
        case 0x0E: output_samples(HL(c[2], c[3]), HL(c[0], c[1])); i += 4; break;
        case 0x0F: end = 1; break;
        case 0x10: mix_auxb_lr(HL(c[0], c[1]), HL(c[2], c[3])); i += 4; break;
        case 0x11: set_opposite_lr(HL(c[0], c[1])); i += 2; break;
        case 0x12:                                            // ASSERT(m_crc != 0x4e8a8b21)
            if (!g_fault) g_fault = SR_F_AX_CMD | 0x12u;
            return;
        case 0x13: send_aux_and_mix(HL(c[0], c[1]), HL(c[2], c[3]), HL(c[4], c[5]),
                                    HL(c[6], c[7]), HL(c[8], c[9]), HL(c[10], c[11])); i += 12; break;
        default: s_unknown_cmds++; end = 1; break;           // ERROR_LOG + end, as the reference
        }
    }
    (void)s_compressor_pos;
}
