// [audio, RECOMP_MUSYX=1] Byte-swap one MusyX ARR ("song") blob BE -> LE, in place.
//
// Split out of gc_musyx_bswap.c because a song is not a container section: it is a graph, and
// it is reached from TWO different places. msmMusPlay either DVD-reads it into its own
// songBuf (src/msm/msmmus.c:352) or points straight into the already-loaded group blob
// (msmmus.c:364, `arrfile = grpHead + grpHead->sngOfs + musData->songOfs`). Hooking the read
// would miss the second path and hooking the group blob would need the music table to find the
// songs inside it, so the hook is at the one point both paths converge: the `arrfile` pointer
// handed to sndSeqPlay (msmmus.c:392). See build_wasm.sh.
//
// BECAUSE THE HOOK IS AT PLAY TIME IT CAN FIRE TWICE on the same bytes — the same song replayed,
// or two songs sharing a group blob — and a double swap is silent corruption. `seen[]` makes
// the swap idempotent per ARR base. The same hazard exists INSIDE one song: tracks alias one
// TENTRY array and patterns are shared between tracks, so the walk dedupes offsets as it goes.
//
// WHAT MUST NOT BE SWAPPED, and why a blanket swap destroys a song:
//   * `tmTab` / `tsTab` are u8[64] lookup tables (seq.c:1113 indexes tmTab as u8*).
//   * The note stream is a MIXED-WIDTH record stream: 6 bytes normally, but 4 when `key & 0x80`
//     or when `(key|velocity) == 0` (seq.c:1011-1019). A fixed 6-byte stride desynchronises it.
//   * Pitch-bend and modulation streams are MIDI-style variable-length BYTE encodings read one
//     byte at a time (seq.c:863-913, `stream[0]`/`stream[1]`), terminated by 0x80 0x00. They are
//     endian-neutral by construction; touching them breaks the song.
//   * A TENTRY's last two bytes are `s8 transpose; s8 velocityAdd` — EXCEPT on a loop entry
//     (`pattern == 0xFFFE`), where seq.c:981 reads them as one u16 element index. The walk
//     branches on `pattern` for exactly this reason.

#include <string.h>

typedef unsigned char u8;   typedef signed char s8;
typedef unsigned short u16; typedef short s16;
typedef unsigned long u32;  typedef long s32;

static u16 bsw16(u16 v) { return (u16)((v >> 8) | (v << 8)); }
static u32 bsw32(u32 v) {
    return (v >> 24) | ((v >> 8) & 0xFF00u) | ((v << 8) & 0xFF0000u) | (v << 24);
}
static void sw16(void *p) { u16 t; memcpy(&t, p, 2); t = bsw16(t); memcpy(p, &t, 2); }
static void sw32(void *p) { u32 t; memcpy(&t, p, 4); t = bsw32(t); memcpy(p, &t, 4); }
static u16  rd16(const void *p) { u16 t; memcpy(&t, p, 2); return t; }
static u32  rd32(const void *p) { u32 t; memcpy(&t, p, 4); return t; }

/* ARR header, include/musyx/seq.h:19-28 — 0x58 bytes, 22 u32s, every offset ARR-base relative
 * (the ARR_GET macro at seq.h:25). */
#define ARR_TTAB   0x00
#define ARR_PTAB   0x04
#define ARR_TMTAB  0x08
#define ARR_MTRACK 0x0C
#define ARR_INFO   0x10
#define ARR_TSTAB  0x54
#define ARR_HDR_WORDS 22

/* Songs already swapped, keyed on base pointer. 128 is far more than MP4 holds live at once
 * (msmMusPlay frees a songBuf when the music stops), and overflowing only costs idempotence
 * for the oldest entry, which is why the table is reported rather than silently wrapped. */
#define SEEN_MAX 128
static const void *seen[SEEN_MAX];
static int seen_n, seen_overflow;

static int already_seen(const void *p) {
    for (int i = 0; i < seen_n; i++) if (seen[i] == p) return 1;
    if (seen_n < SEEN_MAX) seen[seen_n++] = p; else seen_overflow++;
    return 0;
}

/* Per-song dedupe of shared sub-objects (TENTRY arrays, patterns). Offsets, not pointers, so
 * the table is reset per song. */
#define DEDUP_MAX 1024
static u32 dedup[DEDUP_MAX];
static int dedup_n;
static int dedup_hit(u32 off) {
    for (int i = 0; i < dedup_n; i++) if (dedup[i] == off) return 1;
    if (dedup_n < DEDUP_MAX) dedup[dedup_n++] = off;
    return 0;
}

/* SEQ_PATTERN (seq.h:177-183): u32 headerLen, pitchBend, modulation, then the note stream
 * INLINE at +0xC — `noteData` is not an offset, seq.c:1105 takes its address. */
static void swap_pattern(u8 *arr, u32 off, u32 size) {
    if (!off || off + 12 > size || dedup_hit(off)) return;
    u8 *p = arr + off;
    sw32(p + 0);                    /* headerLen — unread by the runtime, swapped for fidelity */
    sw32(p + 4);                    /* pitchBend  offset (0 = none) */
    sw32(p + 8);                    /* modulation offset (0 = none) */
    /* pitchBend/modulation streams themselves are byte streams — deliberately untouched. */

    /* Note stream, seq.c:995-1019. Mixed 4/6-byte records; `time` is a u16 in every record. */
    u32 o = off + 12;
    while (o + 4 <= size) {
        u8 key = p[(o - off) + 2], vel = p[(o - off) + 3];
        sw16(arr + o);                                  /* time */
        if (key == 0xFF && vel == 0xFF) return;         /* terminator (seq.c:1003) */
        if (key & 0x80)            { o += 4; continue; } /* MIDI ctrl/prg, no length  */
        if ((key | vel) == 0)      { o += 4; continue; } /* time-extend padding       */
        if (o + 6 > size) return;
        sw16(arr + o + 4);                              /* length (seq.c:1176) */
        o += 6;
    }
}

/* TENTRY array (seq.h:30-39), 12 bytes, terminated by pattern == 0xFFFF (seq.c:962).
 * Returns the highest pattern index seen, so the caller can size pTab — the count is stored
 * nowhere and seq.c:1104 indexes it unbounded. */
static u32 swap_track(u8 *arr, u32 off, u32 size, u32 maxPattern) {
    if (!off || off >= size || dedup_hit(off)) return maxPattern;
    u32 o = off;
    while (o + 12 <= size) {
        sw32(arr + o + 0);                     /* time */
        sw16(arr + o + 8);                     /* pattern */
        u32 pat = rd16(arr + o + 8);
        if (pat == 0xFFFF) return maxPattern;  /* end of track */
        if (pat == 0xFFFE) sw16(arr + o + 10); /* loop: +0xA is a u16 index (seq.c:981) */
        /* else +0xA/+0xB are two s8 (transpose/velocityAdd) — no swap */
        else if (pat > maxPattern) maxPattern = pat;
        o += 12;
    }
    return maxPattern;
}

/* `size` is a SAFETY BOUND, not a parser input: every structure here self-terminates (tTab is a
 * fixed 64, tracks end at pattern 0xFFFF, mTrack at time -1, note streams at key/vel 0xFF). The
 * group-embedded path (msmmus.c:364) points into the middle of a group blob and has no size to
 * give, so 0 means "unknown" and gets a cap far above any real song. */
#define SONG_SIZE_UNKNOWN_CAP (4u * 1024 * 1024)

void __recomp_bswap_msm_song(void *buf, u32 size) {
    u8 *arr = (u8 *)buf;
    if (!arr) return;
    if (size == 0) size = SONG_SIZE_UNKNOWN_CAP;
    if (size < 0x58) return;
    if (already_seen(arr)) return;
    dedup_n = 0;

    /* 1. header first — every later step needs its (now native) offsets. */
    u32 i, tTab, pTab, mTrack, info, maxPattern, n, o;
    for (i = 0; i < ARR_HDR_WORDS; i++) sw32(arr + i * 4);

    tTab   = rd32(arr + ARR_TTAB);
    pTab   = rd32(arr + ARR_PTAB);
    mTrack = rd32(arr + ARR_MTRACK);
    info   = rd32(arr + ARR_INFO);
    (void)info;                       /* bit 31 = tsTab present; tsTab is bytes, never swapped */

    /* 2. tTab: exactly 64 u32s (seq.c:444-453 loops i < 64), 0 = absent track. */
    maxPattern = 0;
    if (tTab && tTab + 64 * 4 <= size) {
        for (i = 0; i < 64; i++) sw32(arr + tTab + i * 4);
        for (i = 0; i < 64; i++) {
            u32 t = rd32(arr + tTab + i * 4);
            if (t) maxPattern = swap_track(arr, t, size, maxPattern);
        }
    }

    /* 3. mTrack (tempo track): MTRACK_DATA{u32 time; u32 bpm}, ends at time == 0xFFFFFFFF
     *    (seq.h:110-114, seq.c:514). */
    if (mTrack && mTrack < size) {
        o = mTrack;
        while (o + 8 <= size) {
            sw32(arr + o); sw32(arr + o + 4);
            if (rd32(arr + o) == 0xFFFFFFFFu) break;
            o += 8;
        }
    }

    /* 4. pTab + the patterns it names. Sized from the highest index any track referenced,
     *    which is what the runtime actually dereferences. */
    if (pTab && pTab < size) {
        n = maxPattern + 1;
        if (pTab + n * 4 <= size) {
            for (i = 0; i < n; i++) sw32(arr + pTab + i * 4);
            for (i = 0; i < n; i++) swap_pattern(arr, rd32(arr + pTab + i * 4), size);
        }
    }
    /* tmTab and tsTab are u8[64] — intentionally not swapped. */
}

/* Pass-through form, so the hook can wrap the `arrfile` argument in place at msmmus.c:392
 * without needing a statement slot (the same shape gc_anim_bswap.c's
 * __recomp_bswap_animtree_ret uses for HuSprAnimRead). Size is unknown at that call site —
 * see the SONG_SIZE_UNKNOWN_CAP note above. */
void *__recomp_bswap_msm_song_ret(void *arr) {
    __recomp_bswap_msm_song(arr, 0);
    return arr;
}

int __recomp_msm_song_overflow(void) { return seen_overflow; }
