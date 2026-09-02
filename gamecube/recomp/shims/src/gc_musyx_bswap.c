// [audio, RECOMP_MUSYX=1] Byte-swap the MusyX sound bank BE (GameCube disc asset) -> LE
// (wasm native), in place, at the ONE choke point every read goes through.
//
// WHY: MP4's sound data is `/sound/mpgcsnd.msm` (+ `/sound/mpgcstr.pdt`), authored big-endian
// for a PowerPC host. Both the msm wrapper layer (src/msm/*.c) and MusyX itself read every
// field with native struct loads — `sys.header->version`, `m->nextOff`, `cstep->para[0] >> 24`
// — with no byte-order handling anywhere (grep for bswap/endian over src/msm + extern/musyx
// returns zero hits). On wasm32 those loads are little-endian, so the very first check,
// `sys.header->version != MSM_FILE_VERSION` at src/msm/msmsys.c:807, reads 0x02000000 instead
// of 2 and msmSysInit bails with MSM_ERR_INVALIDFILE (-121). MEASURED before this file existed:
// `[OSReport f4] MSM(Sound Manager) Error:Error Code -121`, after which src/game/audio.c:57
// `while (1);` parks the boot forever. Nothing downstream can produce a sample until the bank
// is readable, so this is the first blocker on the whole audio path.
//
// WHERE IT HOOKS: `msmFioRead(fileInfo, addr, length, offset)` (src/msm/msmfio.c:11) is the
// single function all 15 bank reads funnel through. build_wasm.sh redirects its body here.
// One hook beats sprinkling swap calls at 15 call sites: there is exactly one place to audit,
// and a read that this file does not recognise is LOGGED rather than silently mis-swapped.
//
// HOW A READ IS CLASSIFIED: not by call site (msmFioRead cannot see one) but by (file, offset),
// which the container's own header tells us. The two headers are self-identifying — the .msm
// header is the 0x60-byte read at offset 0 (msmsys.c:803) and the .pdt header the 0x20-byte
// read at offset 0 (msmstream.c:323) — and once swapped they name every other section's offset.
// A read is then matched against those offsets. This is why the header must be swapped FIRST:
// every later classification is done with its (now little-endian) fields.
//
// WHAT IS *NOT* SWAPPED — and this is the part that a blanket swap would destroy:
//   * Raw sample bodies (offset >= header.sampOfs). DSP-ADPCM and PCM8 are BYTE streams; the
//     DSP reads them as nibbles/bytes, so they are already correct and swapping them would
//     scramble every sample. (PCM16 bodies WOULD need swapping, but they are handled at the
//     ADPCM/PCM decode boundary, not here, because a sample chunk mixes compression types and
//     only the sample directory says which is which.)
//   * `char`/`s8`/`u8` fields and byte arrays (MSM_GRP_SET is all s8; the `pad[]` members).
// Every multi-byte scalar is swapped EXACTLY ONCE — the trap gc_hsf_bswap.c's header comment
// records, where an offset field used to locate nested data must be swapped BEFORE it is used
// as an offset, and must not then be swapped again by the nested walk.

#include <string.h>

typedef unsigned char u8;   typedef signed char s8;
typedef unsigned short u16; typedef short s16;
typedef unsigned long u32;  typedef long s32;

extern void OSReport(const char *, ...);

/* ---- primitives ------------------------------------------------------------------------ */

static u16 bsw16(u16 v) { return (u16)((v >> 8) | (v << 8)); }
static u32 bsw32(u32 v) {
    return (v >> 24) | ((v >> 8) & 0xFF00u) | ((v << 8) & 0xFF0000u) | (v << 24);
}
/* memcpy-based so these stay valid on unaligned pool data (the pools are packed blobs; a
 * misaligned u32* deref is UB in C even where wasm tolerates it). */
static void sw16(void *p) { u16 t; memcpy(&t, p, 2); t = bsw16(t); memcpy(p, &t, 2); }
static void sw32(void *p) { u32 t; memcpy(&t, p, 4); t = bsw32(t); memcpy(p, &t, 4); }
static u32  rd32(const void *p) { u32 t; memcpy(&t, p, 4); return t; }
static u16  rd16(const void *p) { u16 t; memcpy(&t, p, 2); return t; }
static void sw32n(void *p, u32 n) { u8 *b = (u8 *)p; for (u32 i = 0; i < n; i++) sw32(b + i * 4); }
static void sw16n(void *p, u32 n) { u8 *b = (u8 *)p; for (u32 i = 0; i < n; i++) sw16(b + i * 2); }

/* ---- container headers (include/game/msm_data.h) --------------------------------------- */
/* Mirrored locally rather than #included: this shim is compiled with the plain CFLAGS, not the
 * MusyX unit's -DMUSY_TARGET=0, and msm_data.h pulls in dolphin.h + musyx.h. The layouts are
 * transcribed from msm_data.h:14-37 and :154-164 and are asserted below. */

typedef struct {                 /* MSM_HEADER, msm_data.h:14-37, 0x60 bytes, all s32 */
    s32 magic, version, endOfs, endSize;
    s32 infoOfs; u32 infoSize;
    s32 auxParamOfs; u32 auxParamSize;
    s32 grpInfoOfs, grpInfoSize;
    s32 musOfs, musSize;
    s32 seOfs, seSize;
    s32 grpDataOfs, grpDataSize;
    s32 sampOfs, sampSize;
    s32 dummyMusOfs, dummyMusSize;
    s32 grpSetOfs, grpSetSize;
    s32 pad[2];
} MsmHeader;

typedef struct {                 /* MSM_STREAM_HEADER, msm_data.h:154-164, 0x20 bytes */
    s16 version, streamMax;
    s32 chanMax, sampleFrq, maxBufs;
    u32 streamPackListOfs, adpcmParamOfs, streamPackOfs, sampleOfs;
} PdtHeader;

/* One live bank. MP4 opens exactly one .msm and one .pdt (src/game/audio.c:45-48), but the
 * state is keyed on the DVD start address so a second bank could not be mis-attributed. */
static u32       msm_start;                 /* DVDFileInfo.startAddr of the .msm, 0 = unseen */
static u32       pdt_start;
static MsmHeader msm_hdr;                   /* swapped copy, used to classify later reads */
static PdtHeader pdt_hdr;
static int       msm_hdr_ok, pdt_hdr_ok;
static int       unknown_reads;             /* reads this file could not classify — see notes */

/* ---- MusyX pool structures (extern/musyx/include/musyx/synthdata.h) ---------------------
 * Transcribed with their documented offsets; only the fields the swap needs are named. */

#define SDIR_ENTRY_SIZE 0x20     /* SDIR_DATA, synthdata.h:53-61 */
#define GROUP_DATA_SIZE 0x28     /* GROUP_DATA, synthdata.h:21-43 */

/* SNDADPCMinfo (stream.h:12-20): u16 numCoef; u8 initialPS; u8 loopPS; s16 loopY0; s16 loopY1;
 *                                s16 coefTab[8][2];   => 0x28 bytes.
 * DSPADPCMplusInfo (hardware.h:18-27): the same prefix + DSPADPCMblock blk[] where
 *                                DSPADPCMblock = { s16 Y0; s16 Y1; u8 PS; u8 reserved; }. */
static void swap_adpcm_info(u8 *p, u32 compType, u32 nSamples) {
    sw16(p + 0);                 /* numCoef */
    /* +2 initialPS (u8), +3 loopPS (u8) — byte fields, no swap */
    sw16(p + 4);                 /* loopY0  */
    sw16(p + 6);                 /* loopY1  */
    sw16n(p + 8, 16);            /* coefTab[8][2] */
    if (compType == 1) {         /* per-block seek table, one DSPADPCMblock per 14 samples */
        u32 nblk = (nSamples + 13) / 14;
        u8 *b = p + 0x28;
        for (u32 i = 0; i < nblk; i++) { sw16(b + 0); sw16(b + 2); b += 6; }
    }
}

/* Sample directory: SDIR_DATA[] terminated by id == 0xFFFF (synthdata.c:233), followed by the
 * ADPCM coefficient blocks that each entry's `extraData` offset points into (synthdata.c:557
 * resolves extraData relative to the sdir base).
 *
 * ORDERING: swap each entry's scalars first, THEN use the now-native extraData/header.length
 * to find and swap that entry's coefficient block. compType lives in the top byte of
 * header.length (synthdata.h:47 + hw_dspctrl.c:578) and selects whether extraData is a plain
 * SNDADPCMinfo (0/4/5) or one with a seek table (1); 2/3 are PCM and have no coefficient block
 * (hw_dspctrl.c:632-635, :644-647 zero the coefficients instead of reading any). */
static void swap_sdir(u8 *sdir, u32 limit) {
    u8 *e = sdir;
    u32 n = 0;
    while ((u32)(e - sdir) + SDIR_ENTRY_SIZE <= limit && rd16(e) != 0xFFFF) {
        sw16(e + 0x00);          /* id      */
        sw16(e + 0x02);          /* ref_cnt */
        sw32(e + 0x04);          /* offset  */
        sw32(e + 0x08);          /* addr    */
        sw32(e + 0x0C);          /* header.info       */
        sw32(e + 0x10);          /* header.length     (compType<<24 | nSamples) */
        sw32(e + 0x14);          /* header.loopOffset */
        sw32(e + 0x18);          /* header.loopLength */
        sw32(e + 0x1C);          /* extraData */
        {
            u32 len   = rd32(e + 0x10);
            u32 ctype = len >> 24;
            u32 nsmp  = len & 0xFFFFFFu;
            u32 xd    = rd32(e + 0x1C);
            if ((ctype == 0 || ctype == 1 || ctype == 4 || ctype == 5) && xd && xd < limit)
                swap_adpcm_info(sdir + xd, ctype, nsmp);
        }
        e += SDIR_ENTRY_SIZE;
        n++;
    }
    /* the 0xFFFF terminator is a byte-symmetric u16 — swapping it is a no-op, so leave it */
    (void)n;
}

/* MEM_DATA list (synthdata.h:143-158): { u32 nextOff; u16 id; u16 reserved; <payload> },
 * walked by `while (m->nextOff != 0xFFFFFFFF) m = (u8*)m + m->nextOff` (s_data.c:15-20).
 * `kind` selects the payload swap. nextOff is swapped BEFORE it is used to step. */
enum { POOL_MACRO, POOL_CURVE, POOL_KEYMAP, POOL_LAYER };

static void swap_mem_data_list(u8 *base, u32 off, u32 limit, int kind) {
    if (!off || off >= limit) return;
    u8 *m = base + off;
    int guard;
    u32 i;
    for (guard = 0; guard < 65536; guard++) {
        u32 next, payload;
        u8 *d;
        if ((u32)(m - base) + 8 > limit) return;
        sw32(m + 0);                                  /* nextOff */
        next = rd32(m + 0);
        /* THE TERMINATOR HAS NO PAYLOAD. GetPoolAddr (s_data.c:14-21) stops at
         * `nextOff == 0xFFFFFFFF` and never dereferences that node's id or data, so there is
         * nothing after its 4-byte header belonging to this list — what follows is the NEXT
         * POOL SECTION. Treating the remainder of the pool as this node's payload (which an
         * earlier draft did) swaps the layer list a second time as raw u32s and hands MusyX a
         * corrupt list; the observed symptom was the group walk never terminating. */
        if (next == 0xFFFFFFFFu) return;
        sw16(m + 4);                                  /* id      */
        sw16(m + 6);                                  /* reserved */
        payload = (next > 8) ? (next - 8) : 0;
        if ((u32)(m - base) + next > limit) return;   /* a bad step must not walk out */
        d = m + 8;
        switch (kind) {
        case POOL_MACRO:
            /* MSTEP { u32 para[2] } (synth.h:17-19) — read only via shifts on the two u32s
             * (synthmacros.c:457 `cstep->para[0] >> 8`, :462 `>> 0x18`, :464 `para[1]`), so a
             * plain 2x u32 swap makes every extraction correct. */
            sw32n(d, payload / 4);
            break;
        case POOL_CURVE:
            /* u8 tab[] (synthdata.h:151) — a byte table, DO NOT SWAP. */
            break;
        case POOL_KEYMAP:
            /* KEYMAP map[128] (synthdata.h:134-141): u16 id; s8 transpose; u8 panning;
             * s16 prioOffset; u8 reserved[2]  => 8 bytes, two swappable halfwords. */
            for (i = 0; i + 8 <= payload; i += 8) { sw16(d + i + 0); sw16(d + i + 4); }
            break;
        case POOL_LAYER: {
            /* { u32 num; LAYER entry[num] } (synthdata.h:146-149). LAYER (synthdata.h:122-132):
             * u16 id; u8 keyLow; u8 keyHigh; s8 transpose; u8 volume; s16 prioOffset;
             * u8 panning; u8 reserved[3]  => 0xC bytes, swappable at +0 and +6. */
            u32 num;
            u8 *L;
            sw32(d);
            num = rd32(d);
            L = d + 4;
            for (i = 0; i < num && (i + 1) * 12 + 4 <= payload; i++) {
                sw16(L + i * 12 + 0);
                sw16(L + i * 12 + 6);
            }
            break;
        }
        }
        if (next == 0xFFFFFFFFu) return;
        m += next;
    }
}

/* FX_DATA (synthdata.h:168-176): u16 num; u16 reserved; FX_TAB fx[num].
 * FX_TAB (synthdata.h:168-176 above it): u16 id; u16 macro; then six u8 fields. */
static void swap_fx_table(u8 *base, u32 off, u32 limit) {
    if (!off || off + 4 > limit) return;
    u8 *f = base + off;
    sw16(f + 0); sw16(f + 2);
    u32 num = rd16(f + 0);
    u8 *t = f + 4;
    for (u32 i = 0; i < num && off + 4 + (i + 1) * 10 <= limit; i++) {
        sw16(t + i * 10 + 0);    /* id    */
        sw16(t + i * 10 + 2);    /* macro */
    }
}

/* ID lists: u16 arrays terminated by 0xFFFF, with 0x8000-tagged range pairs
 * (s_data.c:103-113 `while (*ref != 0xFFFF)`, `*ref & 0x8000`, `id <= ref[1]`). */
static void swap_id_list(u8 *base, u32 off, u32 limit) {
    if (!off || off >= limit) return;
    u8 *p = base + off;
    while ((u32)(p - base) + 2 <= limit && rd16(p) != 0xFFFF) { sw16(p); p += 2; }
}

/* MIDISETUP array, terminated by songId == 0xFFFF (s_data.c:302). Swapped defensively as a
 * pair of leading halfwords per 8-byte record; see the note in __recomp_bswap_msm_group. */
static void swap_midi_setup(u8 *base, u32 off, u32 limit) {
    if (!off || off >= limit) return;
    u8 *p = base + off;
    while ((u32)(p - base) + 8 <= limit && rd16(p) != 0xFFFF) { sw16(p); p += 8; }
}

/* PAGE table (include/musyx/seq.h:10-17): u16 macro; u8 prio; u8 maxVoices; u8 index;
 * u8 reserved => 6 bytes. Terminated by `index == 0xFF` (seq.c:315-325), a BYTE at +4, so the
 * scan is endian-agnostic; the terminator entry's `macro` is swapped too, then the walk stops.
 * `macro` is the only multi-byte field and is read natively at seq.c:293 / :307. */
static void swap_page_table(u8 *prj, u32 off, u32 limit) {
    u32 o;
    if (!off || off >= limit) return;
    for (o = off; o + 6 <= limit; o += 6) {
        sw16(prj + o);                      /* macro */
        if (prj[o + 4] == 0xFF) return;     /* index == 0xFF terminates */
    }
}

/* GROUP_DATA linked list (the "project"): synthdata.h:21-43, walked in s_data.c:195-215.
 *
 * THE BASE IS `prj_data`, NOT THE CURRENT NODE — this is the one thing that is easy to get
 * wrong and it is not a detail: s_data.c:215 steps with `g = (GROUP_DATA*)((u8*)prj_data +
 * g->nextOff)`, and every one of the five ID-list offsets plus the fx/song union offsets is
 * likewise resolved against prj_data (s_data.c:198-207, :299-301). Walking node-relative (the
 * MEM_DATA convention, which IS node-relative at s_data.c:20) sent this swapper off into
 * unrelated bytes and MEASURED as `RuntimeError: memory access out of bounds` inside
 * sndPushGroup at frame 344. The first node sits at prj_data + 0 (s_data.c:196 `g = prj_data`). */
static void swap_project(u8 *prj, u32 limit) {
    u8 *base = prj;
    u8 *g = prj;
    for (int guard = 0; guard < 4096; guard++) {
        if ((u32)(g - base) + GROUP_DATA_SIZE > limit) return;
        sw32(g + 0x00);          /* nextOff   */
        sw16(g + 0x04);          /* id        */
        sw16(g + 0x06);          /* type      */
        sw32(g + 0x08);          /* macroOff  */
        sw32(g + 0x0C);          /* sampleOff */
        sw32(g + 0x10);          /* curveOff  */
        sw32(g + 0x14);          /* keymapOff */
        sw32(g + 0x18);          /* layerOff  */
        sw32(g + 0x1C);          /* data.fx.tableOff / data.song.normpageOff  */
        sw32(g + 0x20);          /* data.song.drumpageOff                     */
        sw32(g + 0x24);          /* data.song.midiSetupOff                    */
        {
            u32 type = rd16(g + 0x06);
            /* The five *Off members are ID LISTS (s_data.c:199-203 passes each to ScanIDList),
             * not data pointers — each is a u16 id array ending in 0xFFFF. */
            swap_id_list(base, rd32(g + 0x0C), limit);   /* sampleOff */
            swap_id_list(base, rd32(g + 0x08), limit);   /* macroOff  */
            swap_id_list(base, rd32(g + 0x10), limit);   /* curveOff  */
            swap_id_list(base, rd32(g + 0x14), limit);   /* keymapOff */
            swap_id_list(base, rd32(g + 0x18), limit);   /* layerOff  */
            if (type == 1) {
                /* FX group. The union member at +0x1C is REUSED as the fx-table offset
                 * (s_data.c:205-207 casts it to FX_DATA*), so it is not a normpage here. */
                swap_fx_table(base, rd32(g + 0x1C), limit);
            } else {
                /* Song group (s_data.c:296-301): normpage / drumpage PAGE tables + MIDISETUP. */
                swap_page_table(base, rd32(g + 0x1C), limit);
                swap_page_table(base, rd32(g + 0x20), limit);
                swap_midi_setup(base, rd32(g + 0x24), limit);
            }
        }
        {
            u32 next = rd32(g + 0x00);
            if (next == 0xFFFFFFFFu) return;
            if (next + GROUP_DATA_SIZE > limit) return;
            g = base + next;                 /* prj_data-relative, s_data.c:215 */
        }
    }
}

/* EACH SECTION ENDS WHERE THE NEXT ONE BEGINS. Every walk in this file is terminator-driven
 * (0xFFFF / 0xFFFFFFFF) with a byte limit as its safety net, and the limit therefore has to be
 * the section's real end, not the end of the blob. Bounding by the blob let the project's ID
 * lists and the pool's MEM_DATA chains run past their own section and swap the SAMPLE
 * DIRECTORY a second time — which a validation pass over all 126 of MP4's group blobs caught
 * as a double swap at exactly `sdirOfs` in every single one. The four sections are not in a
 * fixed order, so the end is the smallest of the other offsets that is greater than this one. */
static u32 section_end(u32 off, const u32 *bounds, u32 n, u32 size) {
    u32 e = size, i;
    for (i = 0; i < n; i++)
        if (bounds[i] > off && bounds[i] < e) e = bounds[i];
    return e;
}

/* The per-group blob read at msmsys.c:116 / :519: MSM_GRP_HEAD { poolOfs, projOfs, sdirOfs,
 * sngOfs } (msm_data.h:130-135) followed by those four sections. */
void __recomp_bswap_msm_group(void *buf, u32 size) {
    u8 *b = (u8 *)buf;
    u32 poolOfs, projOfs, sdirOfs, sngOfs, bounds[4], pend;
    if (!b || size < 16) return;
    sw32n(b, 4);                                   /* the four section offsets, first */
    poolOfs = rd32(b + 0); projOfs = rd32(b + 4);
    sdirOfs = rd32(b + 8); sngOfs  = rd32(b + 12);
    bounds[0] = poolOfs; bounds[1] = projOfs; bounds[2] = sdirOfs; bounds[3] = sngOfs;

    if (sdirOfs && sdirOfs < size)
        swap_sdir(b + sdirOfs, section_end(sdirOfs, bounds, 4, size) - sdirOfs);
    /* The project is walked with ITS OWN base: every offset inside it, including the chain
     * step, is relative to prj_data rather than to the blob (s_data.c:196-215). */
    if (projOfs < size)
        swap_project(b + projOfs, section_end(projOfs, bounds, 4, size) - projOfs);
    if (poolOfs && poolOfs + 16 <= size) {         /* POOL_DATA, synthdata.h:160-166 */
        u8 *pool = b + poolOfs;
        pend = section_end(poolOfs, bounds, 4, size) - poolOfs;
        sw32n(pool, 4);
        swap_mem_data_list(pool, rd32(pool + 0x0), pend, POOL_MACRO);
        swap_mem_data_list(pool, rd32(pool + 0x4), pend, POOL_CURVE);
        swap_mem_data_list(pool, rd32(pool + 0x8), pend, POOL_KEYMAP);
        swap_mem_data_list(pool, rd32(pool + 0xC), pend, POOL_LAYER);
    }
}

/* ---- container sections ----------------------------------------------------------------- */

static void swap_msm_info(u8 *p, u32 size) {
    /* MSM_INFO, msm_data.h:39-61. Leading 4 s8 (voices/music/sfx/grpMax), then two s16
     * (musMax/seMax), then 8 s8, then six s32, then baseGrpNum + baseGrp[23] (all s8). */
    if (size < 0x28) return;
    sw16(p + 4); sw16(p + 6);                 /* musMax, seMax */
    sw32n(p + 0x10, 6);                       /* minMem, aramSize, grpBufSizeA/B, dummyMusSize, unk24 */
}

static void swap_msm_grpinfo(u8 *p, u32 size) {
    /* MSM_GRP_INFO, msm_data.h:137-146: u16 gid; s8 stackNo; s8 subGrpId; four s32; u8 pad[12].
     * => 0x20 bytes per entry. */
    for (u32 o = 0; o + 0x20 <= size; o += 0x20) {
        sw16(p + o);                          /* gid */
        sw32n(p + o + 4, 4);                  /* dataOfs, dataSize, sampOfs, sampSize */
    }
}

static void swap_msm_mus(u8 *p, u32 size) {
    /* MSM_MUS, msm_data.h:120-128: u16 sgid; u16 sid; s32 songOfs; s32 songSize; s8 songGrp;
     * s8 vol; u8 pad[2]  => 0x10 bytes. */
    for (u32 o = 0; o + 0x10 <= size; o += 0x10) {
        sw16(p + o); sw16(p + o + 2);
        sw32(p + o + 4); sw32(p + o + 8);
    }
}

static void swap_msm_se(u8 *p, u32 size) {
    /* MSM_SE, msm_data.h:106-118: u16 gid; u16 fxId; s8 vol; s8 pan; s16 pitchBend;
     * u8 span; u8 reverb; u8 chorus; s8 emitterF; s8 emiComp; u8 pad[3]  => 0x10 bytes. */
    for (u32 o = 0; o + 0x10 <= size; o += 0x10) {
        sw16(p + o); sw16(p + o + 2);
        sw16(p + o + 6);                      /* pitchBend */
    }
}

static void swap_msm_auxparam(u8 *p, u32 size) {
    /* MSM_AUXPARAM, msm_data.h:95-104: s8 type; u8 pad[3]; then a union of u32/f32 words.
     * Every union arm is all-4-byte (msm_data.h:63-93), so swapping the tail as u32s covers
     * every arm; f32 and u32 byte-reverse identically. Record size = 4 + max arm (0x24) = 0x28. */
    for (u32 o = 0; o + 0x28 <= size; o += 0x28) sw32n(p + o + 4, 9);
}

/* The .pdt's THREE stream tables. Their roles are easy to swap around, and getting them wrong
 * is what made the title screen panic: `streamPackListOfs` is NOT an array of packs.
 *   streamPackListOfs .. adpcmParamOfs : `u32* streamPackList` (msmstream.c:63) — one FILE
 *       OFFSET per stream id, 0 = absent. Indexed directly by stream id (msmstream.c:237).
 *   adpcmParamOfs .. streamPackOfs     : `SND_ADPCMSTREAM_INFO* adpcmParam` (msmstream.c:65),
 *       and that struct is a BARE `s16 coefTab[8][2]` (musyx.h:336-338) = 0x20 bytes — NOT the
 *       SNDADPCMinfo used inside a group's sample directory, which has a numCoef/PS/loop
 *       prefix. Verified on the retail disc: 30 entries, all 480 coefficients inside Q11 range.
 *   streamPackOfs .. sampleOfs         : the MSM_STREAM_PACK records themselves. Despite the
 *       field being typed `s8* streamPackFlag`, msmstream.c:610 casts
 *       `streamPackFlag + (streamPackList[id] - streamPackOfs)` to MSM_STREAM_PACK*.
 * The reads are rounded up to a 0x20 multiple (msmstream.c:332/341), so the tail may include
 * padding; swapping padding is harmless, reading past the buffer is not, hence the bounds. */

static void swap_pdt_packlist(u8 *p, u32 size) {   /* u32 offset table */
    sw32n(p, size / 4);
}

static void swap_pdt_adpcm(u8 *p, u32 size) {      /* s16 coefTab[8][2] per entry */
    sw16n(p, size / 2);
}

static void swap_pdt_packs(u8 *p, u32 size) {
    /* MSM_STREAM_PACK, msm_data.h:172-183: six s8; u16 frq; u32 loopOfsEnd; u32 loopOfsStart;
     * MSM_STREAM stream[2] where MSM_STREAM = { s32 sampleOfs; s16 adpcmParamIdx; u16 pad; }
     * (msm_data.h:166-170)  => 6 + 2 + 4 + 4 + 2*8 = 0x20 bytes. Every offset the pack list
     * names is 0x20-aligned within this region, so a straight stride walk covers exactly the
     * same records the runtime reaches. */
    u32 o, s;
    for (o = 0; o + 0x20 <= size; o += 0x20) {
        sw16(p + o + 6);                      /* frq */
        sw32(p + o + 8); sw32(p + o + 12);    /* loopOfsEnd, loopOfsStart */
        for (s = 0; s < 2; s++) {
            sw32(p + o + 16 + s * 8);         /* sampleOfs      */
            sw16(p + o + 20 + s * 8);         /* adpcmParamIdx  */
        }
    }
}

/* Song (sequence) blobs. Declared here, defined in gc_msm_song_bswap.c so the sequencer format
 * can be iterated without touching the container classifier. */
void __recomp_bswap_msm_song(void *buf, u32 size);

/* ---- the hook -------------------------------------------------------------------------- */
/* Called from msmFioRead AFTER the bytes have landed. `startAddr` identifies which container
 * this read came from (DVDFileInfo.startAddr; the two banks have different disc addresses). */
void __recomp_bswap_msm_read(u32 startAddr, void *addr, s32 length, s32 offset) {
    u8 *p = (u8 *)addr;
    if (!p || length <= 0) return;
    u32 len = (u32)length;

    /* --- the two self-identifying headers --- */
    if (offset == 0 && len == 0x60) {                 /* msmsys.c:803 */
        sw32n(p, 0x60 / 4);
        memcpy(&msm_hdr, p, sizeof(MsmHeader));
        msm_start = startAddr; msm_hdr_ok = 1;
        return;
    }
    if (offset == 0 && len == 0x20) {                 /* msmstream.c:323 */
        sw16(p + 0); sw16(p + 2);                     /* version, streamMax */
        sw32n(p + 4, 7);                              /* chanMax .. sampleOfs */
        memcpy(&pdt_hdr, p, sizeof(PdtHeader));
        pdt_start = startAddr; pdt_hdr_ok = 1;
        return;
    }

    if (msm_hdr_ok && startAddr == msm_start) {
        const MsmHeader *h = &msm_hdr;
        if (offset >= h->sampOfs) return;                          /* raw sample bodies: byte streams */
        if (offset == h->infoOfs)      { swap_msm_info(p, len);     return; }
        if (offset == h->grpInfoOfs)   { swap_msm_grpinfo(p, len);  return; }
        if (offset == h->musOfs)       { swap_msm_mus(p, len);      return; }
        if (offset == h->seOfs)        { swap_msm_se(p, len);       return; }
        if (offset == h->auxParamOfs && h->auxParamSize)
                                       { swap_msm_auxparam(p, len); return; }
        if (offset == h->grpSetOfs)    { return; }                 /* MSM_GRP_SET is all s8 */
        if (offset >= h->grpDataOfs && offset < h->grpDataOfs + h->grpDataSize) {
            __recomp_bswap_msm_group(p, len);                      /* pool/proj/sdir/song blob */
            return;
        }
        if (h->dummyMusSize && offset >= h->dummyMusOfs &&
            offset < h->dummyMusOfs + h->dummyMusSize) {
            /* Song blobs (msmmus.c:352). NOT swapped here: msmMusPlay reaches a song by two
             * routes — this DVD read, and a direct pointer into an already-loaded group blob
             * (msmmus.c:364) that never passes through msmFioRead at all. Swapping here would
             * cover only the first. The hook is instead at the point both routes converge, the
             * `arrfile` handed to sndSeqPlay; see gc_musyx_song_bswap.c. */
            return;
        }
    } else if (pdt_hdr_ok && startAddr == pdt_start) {
        const PdtHeader *h = &pdt_hdr;
        if ((u32)offset == h->streamPackListOfs) { swap_pdt_packlist(p, len); return; }
        if ((u32)offset == h->adpcmParamOfs)     { swap_pdt_adpcm(p, len);    return; }
        if ((u32)offset == h->streamPackOfs)     { swap_pdt_packs(p, len);    return; }
        return;                                                    /* stream sample bodies */
    }

    /* Not classified. Report once per read rather than guessing: a wrong swap is silent
     * corruption, an unswapped section fails loudly downstream and names itself here. */
    if (++unknown_reads <= 8)
        OSReport("MSMBSWAP unclassified read: start=%08x ofs=%d len=%d\n",
                 (unsigned)startAddr, (int)offset, (int)length);
}

int __recomp_msm_bswap_unknowns(void) { return unknown_reads; }
