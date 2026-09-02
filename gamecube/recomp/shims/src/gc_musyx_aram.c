// [audio, RECOMP_MUSYX=1] MusyX's ARAM store — where sample bodies actually live.
//
// REPLACES extern/musyx/src/musyx/runtime/hw_aramdma.c, which build_wasm.sh excludes when this
// file is compiled. Same reasoning, and the same mechanism, as gc_musyx_hw.c replacing hw_pc.c:
// exclusion BY NAME rather than `--allow-multiple-definition`, because a stub that silently
// shadows a real definition is the `__frsqrte`/`sqrtf` failure that cost a whole render debug.
//
// WHY IT IS NEEDED. hw_aramdma.c has two branches. The DOLPHIN branch (:13-343) is a complete
// ARAM allocator: a bump pointer for sample data growing up from `aramBase`, 64 stream buffers
// carved down from `aramTop`, and ARQ DMA to move bytes. The MUSY_TARGET_PC branch (:344-422),
// which is the one this port compiles, is ENTIRELY STUBS — `aramUploadData` has no body (:387),
// `aramInit` has no body (:392), `aramStoreData` is `{}` on a `void*` return type (:401), and
// `aramAllocateStreamBuffer` returns 0xFF-less garbage (:407). Nothing is ever stored.
//
// That stub branch is load-bearing in a way that is easy to miss, because it changes the MEANING
// of every _PB address. hardware.c:478 `hwSaveSample` is
//     void hwSaveSample(void* header, void* data) {
//     #if MUSY_TARGET == MUSY_TARGET_DOLPHIN
//       ... *((u32*)data) = (u32)aramStoreData((void*)*((u32*)data), len);
//     #endif
//     }
// i.e. on Dolphin it OVERWRITES `sdir->addr` — set one line earlier at synthdata.c:352 to
// `sdir->offset + dataSmpSDirs[i].base`, a MAIN-RAM pointer — with the ARAM offset the data was
// copied to. Under MUSY_TARGET_PC that whole body vanishes and `sdir->addr` stays a main-RAM
// pointer. MEASURED consequence before this file existed: a playing SFX voice's _PB carried
// `smpAddr=0x80c9d4e0`, and hw_dspctrl.c:594 computes the nibble address as
// `base = (u32)smp_info.addr * 2`, so 0x80c9d4e0 * 2 = 0x1_0193A9C0 TRUNCATES TO 0x0193A9C0 —
// bit 31 is gone. The read cursor landed at byte 0xC9D4E1 and found zeros in both candidate
// buffers (`nonZeroARAM=0/512 nonZeroMAIN=0/512`), while the real sample body sat at 0x80C9D4E0.
// The overflow is not a bug in MusyX: on hardware `sdir->addr` after hwSaveSample is an ARAM
// offset below 16 MB, so doubling it never overflows. Restoring the ARAM store restores that
// invariant, which is why this is the correct fix rather than teaching the mixer about pointers.
//
// SEPARATE BUFFER, DELIBERATELY. This does NOT allocate out of shims/src/gc_aram.c's
// `__recomp_aram`. That buffer is the GAME's ARAM staging store (HuAR_DVDtoARAM copies DVD data
// through it), and on real hardware the two regions are kept apart by the AR heap, which this
// port does not model — MusyX is handed `smpBase = 0` (snd_init.c:49 `dataInit(0, aramSize)`,
// and hwInitSampleMem asserts baseAddr == 0), so sharing would put MusyX's bump allocator on top
// of the game's staging area with nothing to stop either overwriting the other. A dedicated
// region cannot collide, and costs only BSS.
//
// The transfers are synchronous memcpy. On hardware they are ARQ DMA and `aramSyncTransferQueue`
// spins until the queue drains; here the copy is already complete when the call returns, so the
// spin is a no-op and any completion callback fires immediately. No clock is read anywhere in
// this file (CLAUDE.md gate #9).

#include <string.h>

#include "musyx/musyx.h"
#include "musyx/hardware.h"

#define MUSYX_ARAM_SIZE   0x1000000u        /* 16 MB, the real console's whole ARAM */
#define ARAM_ZERO_BYTES   (640u * 2u)       /* hw_aramdma.c:134 seeds 640 s16 of silence */

static u8  musyx_aram[MUSYX_ARAM_SIZE];
static u32 aramTop, aramWrite, aramStream;
static ARAMUploadCallback aramUploadCallback;
static u32 aramUploadChunkSize;

/* The mixer reads sample bytes through this. */
void *__recomp_musyx_aram_base(void) { return musyx_aram; }
u32   __recomp_musyx_aram_size(void) { return MUSYX_ARAM_SIZE; }

/* Diagnostics: "no sound" must be attributable to a specific stage, and a silent allocator
 * failure (ARAM exhausted, or never initialised) looks exactly like a broken mixer. */
static u32 aram_stores, aram_store_bytes, aram_store_fails, aram_upload_oob;
u32 __recomp_musyx_aram_stat(s32 which) {
    switch (which) {
    case 0: return aramTop;
    case 1: return aramWrite;
    case 2: return aramStream;
    case 3: return aram_stores;
    case 4: return aram_store_bytes;
    case 5: return aram_store_fails;
    case 6: return aram_upload_oob;
    default: return 0;
    }
}

/* ---- transfers --------------------------------------------------------------------------- */
/* hw_aramdma.c:74-107. `mram` is a wasm pointer (guest main RAM is flat here), `aram` an offset
 * into musyx_aram. The bounds check is this port's own: a real ARQ would fault, and silently
 * dropping an out-of-range copy would reappear later as a voice reading zeros. */
void aramUploadData(void *mram, u32 aram, u32 len, u32 highPrio,
                    void (*callback)(size_t), u32 user) {
    (void)highPrio;
    if (mram && len && aram < MUSYX_ARAM_SIZE && len <= MUSYX_ARAM_SIZE &&
        aram + len <= MUSYX_ARAM_SIZE) {
        memcpy(musyx_aram + aram, mram, len);
    } else if (len) {
        aram_upload_oob++;
    }
    if (callback) callback((size_t)user);
}

void aramSyncTransferQueue(void) { }

/* ---- lifetime ---------------------------------------------------------------------------- */
/* hw_aramdma.c:117-146. aramBase is 0 here (see the header comment); the first ARAM_ZERO_BYTES
 * are left as silence and are what aramGetZeroBuffer hands out — a non-looping voice that runs
 * off its end is pointed at them (hw_dspctrl.c:707-717), so they must really be zero. */
void aramInit(u32 length) {
    memset(musyx_aram, 0, ARAM_ZERO_BYTES);
    aramTop = (length && length < MUSYX_ARAM_SIZE) ? length : MUSYX_ARAM_SIZE;
    if (aramTop <= ARAM_ZERO_BYTES) aramTop = MUSYX_ARAM_SIZE;
    aramWrite = ARAM_ZERO_BYTES;
    aramStream = aramTop;
    aramUploadCallback = NULL;
    aramUploadChunkSize = 0;
}

void aramExit(void) { }

u32 aramGetZeroBuffer(void) { return 0; }

void aramSetUploadCallback(ARAMUploadCallback callback, u32 chunckSize) {
    if (callback != NULL) {
        chunckSize = (chunckSize + 31) & ~31u;
        /* ARQGetChunkSize() is the hardware DMA chunk floor; with a synchronous memcpy there is
         * no DMA granularity to respect, so the caller's own request stands. */
        aramUploadChunkSize = chunckSize ? chunckSize : 0x2000u;
    }
    aramUploadCallback = callback;
}

/* ---- the sample store -------------------------------------------------------------------- */
/* hw_aramdma.c:165-211. Returns the ARAM OFFSET, which hwSaveSample writes back over
 * `sdir->addr`. Returning an offset rather than a pointer is the whole point (see header). */
void *aramStoreData(void *src, u32 len) {
    u32 addr;
    len = (len + 31) & ~31u;
    if (!src || aramWrite + len > aramStream) { aram_store_fails++; return (void *)(size_t)aramWrite; }
    addr = aramWrite;
    if (aramUploadCallback == NULL) {
        aramUploadData(src, aramWrite, len, 0, NULL, 0);
        aramWrite += len;
    } else {
        while (len != 0) {
            u32 blk = (len >= aramUploadChunkSize) ? aramUploadChunkSize : len;
            void *buffer = (void *)aramUploadCallback((u32)(size_t)src, blk);
            aramUploadData(buffer, aramWrite, blk, 0, NULL, 0);
            len -= blk;
            aramWrite += blk;
            src = (void *)((u8 *)src + blk);
        }
    }
    aram_stores++;
    aram_store_bytes += (aramWrite - addr);
    return (void *)(size_t)addr;
}

void aramRemoveData(void *aram, u32 len) {
    len = (len + 31) & ~31u;
    if (aramWrite >= len && (u32)(size_t)aram == aramWrite - len) aramWrite -= len;
}

/* ---- stream buffers ---------------------------------------------------------------------- */
/* hw_aramdma.c:196-343, same free/idle/used three-list scheme, carved DOWN from aramTop so the
 * sample bump allocator growing UP can never meet it (that is what `aramWrite + len > aramStream`
 * in aramStoreData checks). */
typedef struct STREAM_BUF {
    struct STREAM_BUF *next;
    u32 aram, length, allocLength;
} STREAM_BUF;

static STREAM_BUF  streamBuffers[64];
static STREAM_BUF *usedStreamBuffers, *freeStreamBuffers, *idleStreamBuffers;
static int         streamBuffersReady;

static void InitStreamBuffers(void) {
    u32 i;
    usedStreamBuffers = NULL;
    freeStreamBuffers = NULL;
    idleStreamBuffers = streamBuffers;
    for (i = 1; i < 64; ++i) streamBuffers[i - 1].next = &streamBuffers[i];
    streamBuffers[63].next = NULL;
    aramStream = aramTop;
    streamBuffersReady = 1;
}

u8 aramAllocateStreamBuffer(u32 len) {
    STREAM_BUF *sb, *oSb = NULL, *lastSb = NULL;
    u32 minLen = 0xFFFFFFFFu;

    if (!streamBuffersReady) InitStreamBuffers();
    len = (len + 31) & ~31u;

    for (sb = freeStreamBuffers; sb != NULL; sb = sb->next) {
        if (sb->allocLength == len) { oSb = sb; break; }
        if (sb->allocLength > len && minLen > sb->allocLength) { oSb = sb; minLen = sb->allocLength; }
        lastSb = sb;
    }

    if (oSb == NULL) {
        if (idleStreamBuffers != NULL && aramStream >= len && aramStream - len >= aramWrite) {
            oSb = idleStreamBuffers;
            idleStreamBuffers = oSb->next;
            oSb->allocLength = len;
            oSb->length = len;
            aramStream -= len;
            oSb->aram = aramStream;
            oSb->next = usedStreamBuffers;
            usedStreamBuffers = oSb;
        }
    } else {
        if (lastSb != NULL) lastSb->next = oSb->next;
        else freeStreamBuffers = oSb->next;
        oSb->length = len;
        oSb->next = usedStreamBuffers;
        usedStreamBuffers = oSb;
    }

    if (oSb == NULL) return 0xFF;
    return (u8)(oSb - streamBuffers);
}

size_t aramGetStreamBufferAddress(u8 id, size_t *len) {
    if (id == 0xFF) { if (len) *len = 0; return 0; }
    if (len) *len = streamBuffers[id].length;
    return streamBuffers[id].aram;
}

void aramFreeStreamBuffer(u8 id) {
    STREAM_BUF *fSb, *sb, *lastSb, *nextSb;
    u32 minAddr;

    if (id == 0xFF || !streamBuffersReady) return;
    fSb = &streamBuffers[id];
    lastSb = NULL;
    for (sb = usedStreamBuffers; sb != NULL; sb = sb->next) {
        if (sb == fSb) {
            if (lastSb != NULL) lastSb->next = fSb->next;
            else usedStreamBuffers = fSb->next;
            break;
        }
        lastSb = sb;
    }

    if (fSb->aram == aramStream) {
        fSb->next = idleStreamBuffers;
        idleStreamBuffers = fSb;
        minAddr = 0xFFFFFFFFu;
        for (sb = usedStreamBuffers; sb != NULL; sb = sb->next)
            if (sb->aram <= minAddr) minAddr = sb->aram;
        lastSb = NULL;
        sb = freeStreamBuffers;
        while (sb != NULL) {
            nextSb = sb->next;
            if (sb->aram < minAddr) {
                if (lastSb != NULL) lastSb->next = sb->next;
                else freeStreamBuffers = sb->next;
                sb->next = idleStreamBuffers;
                idleStreamBuffers = sb;
            } else {
                lastSb = sb;
            }
            sb = nextSb;
        }
        aramStream = (minAddr != 0xFFFFFFFFu) ? minAddr : aramTop;
        return;
    }
    fSb->next = freeStreamBuffers;
    freeStreamBuffers = fSb;
}
