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
// the swap idempotent per ARR base, and the msmFioRead hook invalidates an entry when fresh
// bytes land on it (the music players re-use ONE buffer each — see the seen[] note). The same
// hazard exists INSIDE one song: tracks alias one TENTRY array and patterns are shared between
// tracks, so the walk dedupes offsets as it goes.
//
// EVERY DOUBLE-SWAP IN THIS FILE HAS THE SAME SIGNATURE, so recognise it once: a u32 that should
// be a small ARR-relative offset comes back looking like 0xNN0100_00 — a plausible little value
// with its bytes reversed — and ARR_GET turns it into an address hundreds of megabytes past the
// blob. It surfaces as `RuntimeError: memory access out of bounds` deep inside seq.c, nowhere
// near the swapper. Two of them have already been paid for: the fixed-0x58 header assumption
// (see ARR_HDR_MIN) and the base-pointer song identity (see seen[]).
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

extern void OSReport(const char *, ...);

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

/* ARR header, include/musyx/seq.h:19-28 — every offset is ARR-base relative (the ARR_GET macro
 * at seq.h:25).
 *
 * ⚠ THE HEADER IS NOT A FIXED 0x58 BYTES, AND ASSUMING IT WAS IS THE BUG THAT COST THE AUDIO
 * BUILD A SHIP. seq.h declares ARR as 22 u32s — tTab, pTab, tmTab, mTrack, info, loopPoint[16],
 * tsTab — but that is the MAXIMAL shape. A song stores only as many loopPoint entries as it has
 * sections, and its track table starts immediately afterwards. MEASURED on MP4's mode-select
 * song (base 0x80494020, the first sequence played after the title): its header reads
 * `tTab=0x18 pTab=0x310 tmTab=0x34c0 mTrack=0 info=0x5a` — tTab=0x18 means the track table
 * begins where loopPoint[1] would be. A blanket 22-word header swap therefore covered the first
 * 16 TRACK-TABLE entries, and step 2 below swapped those same bytes a SECOND time, leaving them
 * big-endian. Measured post-swap, with the blanket header swap still in:
 *     TRACKTAB[0..3]: 0 18010000 3c010000 60010000        <- big-endian, should be 0 118 13c 160
 * seq.c:444 then does `nseq->track[i].addr = ARR_GET(arr, tracktab[i])`, i.e.
 * 0x80494020 + 0x18010000 = 0x984A4020, past the end of a 0x82000000-byte linear memory, and
 * GenerateNextTrackEvent (seq.c:962, `track->addr->pattern`) traps:
 *     [recomp-worker] main stopped: memory access out of bounds
 *       at GenerateNextTrackEvent <- seqStartPlay <- msmMusPlay <- HuAudSeqPlay <- fn_ms1_414
 * So the header's extent is DERIVED — it ends at the lowest offset any header field points to —
 * never assumed. Only the first five words are unconditionally header. */
#define ARR_TTAB   0x00
#define ARR_PTAB   0x04
#define ARR_TMTAB  0x08
#define ARR_MTRACK 0x0C
#define ARR_INFO   0x10
#define ARR_TSTAB  0x54
#define ARR_HDR_MIN 0x14u   /* tTab, pTab, tmTab, mTrack, info — always present  */
#define ARR_HDR_MAX 0x58u   /* seq.h's maximal ARR: + loopPoint[16] + tsTab      */

/* Songs already swapped, keyed on base pointer. 128 is far more than MP4 holds live at once
 * (msmMusPlay frees a songBuf when the music stops), and overflowing only costs idempotence
 * for the oldest entry, which is why the table is reported rather than silently wrapped.
 *
 * ⚠ A BASE POINTER IS NOT A SONG IDENTITY. msmmus.c:438 gives each music player ONE fixed
 * buffer — `mus.player[i].songBuf = mus.musBuf + dummyMusSize * i` — and msmmus.c:352 reads
 * every DVD-path song into it, so the second song a player loads has the SAME base as the
 * first. Keyed on the pointer alone this table would then report "already swapped" for fresh
 * big-endian bytes, leave them unswapped, and hand seq.c:444 a big-endian track offset — the
 * same `memory access out of bounds` in GenerateNextTrackEvent that the header-extent bug
 * above produced, from a different cause. The pointer key still has to exist, because
 * msmMusPlay calls sndSeqPlay on EVERY play including a replay that re-reads nothing
 * (msmmus.c:349 `if (player->musId != musId)` guards the read, not the play), and a second
 * swap of the same bytes is silent corruption. So the entry is invalidated at the one moment
 * that provably makes it stale: bytes landing over it from msmFioRead. */
#define SEEN_MAX 128
static const void *seen[SEEN_MAX];
static int seen_n, seen_overflow, forgotten;

static int already_seen(const void *p) {
    for (int i = 0; i < seen_n; i++) if (seen[i] == p) return 1;
    if (seen_n < SEEN_MAX) seen[seen_n++] = p; else seen_overflow++;
    return 0;
}

/* Called from gc_musyx_bswap.c's msmFioRead hook AFTER the bytes have landed: any song base
 * inside the overwritten range is fresh big-endian data again and must be swapped on next play.
 * Covers both routes — a song read into a reused songBuf, and a group blob reloaded at the same
 * address with different songs embedded in it. */
void __recomp_msm_song_forget_range(const void *addr, u32 len) {
    const u8 *lo = (const u8 *)addr, *hi = lo + len;
    int i = 0;
    if (!lo || !len) return;
    while (i < seen_n) {
        const u8 *b = (const u8 *)seen[i];
        if (b >= lo && b < hi) { seen[i] = seen[--seen_n]; forgotten++; }  /* unordered: fill from the end */
        else i++;
    }
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
        /* BOTH 0xFFFF AND 0xFFFE END THE LINEAR WALK, and missing the second one is what broke
         * this file. seq.c:962 retires the track on 0xFFFF; seq.c:975-982 handles 0xFFFE by
         * JUMPING — `track->addr = &track->base[*(u16*)&track->addr->transpose]` — so control
         * never falls through a loop entry either. Treating 0xFFFE as "keep scanning" walked
         * straight out of each track and into the next one, swapping its entries a SECOND time.
         * MEASURED on MP4's mode-select song, with the old `continue`: every one of the 14
         * tracks reported term=0 (no 0xFFFF ever found) and the damage alternated exactly as
         * overlapping overruns predict —
         *     TRK off=118 entries=25 term=0 t0pat=0   t1pat=1    t2pat=fffe
         *     TRK off=13c entries=25 term=0 t0pat=200 t1pat=300  t2pat=feff   <- byte-reversed
         *     TRK off=160 entries=25 term=0 t0pat=4   t1pat=5    t2pat=fffe
         * and the returned maxPattern came back as 0xfeff (a double-swapped 0xfffe) instead of
         * 0x1b. Step 4 then sized the pattern table at 65,536 entries and handed swap_pattern
         * tens of thousands of garbage offsets, which wrote over the track table itself and
         * produced the OOB in GenerateNextTrackEvent that this whole file exists to prevent. */
        if (pat == 0xFFFF) break;              /* end of track (seq.c:962)        */
        if (pat == 0xFFFE) { sw16(arr + o + 10); break; }  /* loop-jump (seq.c:981): +0xA is a
                                                * u16 element index, not transpose/velocityAdd */
        /* otherwise +0xA/+0xB are two s8 (transpose/velocityAdd) — no swap */
        if (pat > maxPattern) maxPattern = pat;
        o += 12;
    }
    return maxPattern;
}

/* `size` is a SAFETY BOUND, not a parser input: every structure here self-terminates (tTab is a
 * fixed 64, tracks end at pattern 0xFFFF, mTrack at time -1, note streams at key/vel 0xFF). The
 * group-embedded path (msmmus.c:364) points into the middle of a group blob and has no size to
 * give, so 0 means "unknown" and gets a cap far above any real song. */
#define SONG_SIZE_UNKNOWN_CAP (4u * 1024 * 1024)

/* A song whose header contradicts the model above (see ARR_HDR_MIN): reported, never guessed
 * at. gc_musyx_bswap.c's unclassified-read report is the same doctrine — a wrong swap is silent
 * corruption, a refused one fails loudly downstream and names itself here. */
static int hdr_conflicts;

void __recomp_bswap_msm_song(void *buf, u32 size) {
    u8 *arr = (u8 *)buf;
    if (!arr) return;
    if (size == 0) size = SONG_SIZE_UNKNOWN_CAP;
    if (size < ARR_HDR_MIN) return;
    if (already_seen(arr)) return;
    dedup_n = 0;

    /* 1. the five ALWAYS-header words first — every later step needs their native values. */
    u32 i, tTab, pTab, tmTab, mTrack, info, hdrEnd, maxPattern, n, o;
    for (i = 0; i * 4 < ARR_HDR_MIN; i++) sw32(arr + i * 4);

    tTab   = rd32(arr + ARR_TTAB);
    pTab   = rd32(arr + ARR_PTAB);
    tmTab  = rd32(arr + ARR_TMTAB);
    mTrack = rd32(arr + ARR_MTRACK);
    info   = rd32(arr + ARR_INFO);

    /* 1b. the VARIABLE tail — loopPoint[0..sections-1], then tsTab when the song has one. It
     *     runs up to the first byte any header offset claims, which is where the song's own
     *     data begins. loopPoint IS read (seq.c:1265, `arrbase->loopPoint[secIndex]`), so the
     *     entries that really exist must be swapped; the ones that do not exist are somebody
     *     else's bytes and must not be touched. */
    hdrEnd = ARR_HDR_MAX;
    if (tTab   && tTab   < hdrEnd) hdrEnd = tTab;
    if (pTab   && pTab   < hdrEnd) hdrEnd = pTab;
    if (tmTab  && tmTab  < hdrEnd) hdrEnd = tmTab;
    if (mTrack && mTrack < hdrEnd) hdrEnd = mTrack;
    if (hdrEnd < ARR_HDR_MIN) {       /* an offset pointing INTO the fixed header: not an ARR */
        if (++hdr_conflicts <= 8)
            OSReport("MSMSONG header underflow: hdrEnd=%x tTab=%x pTab=%x tmTab=%x mTrack=%x\n",
                     (unsigned)hdrEnd, (unsigned)tTab, (unsigned)pTab,
                     (unsigned)tmTab, (unsigned)mTrack);
        return;
    }
    if (hdrEnd > size) hdrEnd = size;
    for (o = ARR_HDR_MIN; o + 4 <= hdrEnd; o += 4) sw32(arr + o);
    /* tsTab sits at 0x54, i.e. inside that tail, so the loop above covers it exactly when the
     * song really has a full 0x58 header. If a song claims one (info bit 31) but its data
     * starts before 0x58, the model is wrong for that song — say so rather than swap a byte
     * that belongs to the track table. */
    if ((info & 0x80000000u) && hdrEnd <= ARR_TSTAB && ++hdr_conflicts <= 8)
        OSReport("MSMSONG tsTab claimed but header ends at %x (tTab=%x) — left unswapped\n",
                 (unsigned)hdrEnd, (unsigned)tTab);

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
     *    which is what the runtime actually dereferences (seq.c:1104 indexes it unbounded).
     *
     *    BUT maxPattern IS PARSED DATA, SO IT IS CAPPED BY THE LAYOUT — a wrong one must cost
     *    unswapped bytes, never a wild write. The patterns live AFTER their table, so the table
     *    ends where the first pattern it names begins; that bound is in the song itself and
     *    needs no trust. Paid for: with swap_track mis-scanning past 0xFFFE, maxPattern came
     *    back 0xfeff, this loop swapped 65,536 entries out of a ~13 KB song and handed
     *    swap_pattern that many garbage offsets, which wrote over the TRACK TABLE at 0x18 and
     *    produced the very out-of-bounds this file exists to prevent. With the cap, the same
     *    bad input truncates and says so instead. */
    if (pTab && pTab < size) {
        u32 want = maxPattern + 1, limit = size;
        n = 0;
        while (n < want && pTab + (n + 1) * 4 <= limit) {
            u32 v;
            sw32(arr + pTab + n * 4);
            v = rd32(arr + pTab + n * 4);
            if (v && v > pTab && v < limit) limit = v;   /* table ends at its first pattern */
            n++;
        }
        if (n < want && ++hdr_conflicts <= 8)
            OSReport("MSMSONG pTab capped at %d of %d entries (pTab=%x limit=%x) — song under-swapped\n",
                     (unsigned)n, (unsigned)want, (unsigned)pTab, (unsigned)limit);
        for (i = 0; i < n; i++) swap_pattern(arr, rd32(arr + pTab + i * 4), size);
    }
    /* tmTab and tsTab are u8[64] — intentionally not swapped. */
}

/* Counters, not logs: a per-song log line would be noise on the happy path, but "how many songs
 * did the reader have to re-swap" and "how many headers did it refuse" are the two numbers that
 * say whether this file is doing its job. 0 conflicts and a nonzero forget count is health. */
int __recomp_msm_song_conflicts(void) { return hdr_conflicts; }
int __recomp_msm_song_forgotten(void) { return forgotten; }

/* Pass-through form, so the hook can wrap the `arrfile` argument in place at msmmus.c:392
 * without needing a statement slot (the same shape gc_anim_bswap.c's
 * __recomp_bswap_animtree_ret uses for HuSprAnimRead). Size is unknown at that call site —
 * see the SONG_SIZE_UNKNOWN_CAP note above. */
void *__recomp_bswap_msm_song_ret(void *arr) {
    __recomp_bswap_msm_song(arr, 0);
    return arr;
}

int __recomp_msm_song_overflow(void) { return seen_overflow; }
