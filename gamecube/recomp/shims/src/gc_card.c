/* gamecube/recomp/shims/src/gc_card.c
 *
 * RAM-backed GameCube Memory Card for the wasm recomp (host subsystem, like GX/VI/DVD/ARAM).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * build_wasm.sh:535's skip_unit excludes the src/dolphin/card/ tree from the compile (its
 * case pattern is the glob for that directory), so every CARD
 * entry point is an UNDEFINED symbol and becomes a wasm import. Measured on the shipped
 * binary (wasm-objdump -j Import -x gamecube/recomp/mp4_game.wasm): EXACTLY 17 CARD imports
 * -- CARDInit, CARDProbeEx, CARDMount, CARDCheck, CARDUnmount, CARDFormat, CARDOpen,
 * CARDRead, CARDGetSectorSize, CARDFreeBlocks, CARDCreate, CARDClose, CARDWrite, CARDDelete,
 * CARDGetSerialNo, CARDGetStatus, CARDSetStatus. recomp_worker.js:497 answers all of them
 * from a generic `default: return 0` stub = CARD_RESULT_READY with NO out-parameter written,
 * which is exactly the observed bug: HuCardSlotCheck (~/gc_refs/marioparty4/src/game/card.c:41-53)
 * returns its uninitialised `sectorSize` local, and filesel's fn_1_5C38
 * (src/REL/modeseldll/filesel.c:688,697) requires EXACTLY 8192, so the slot bitmask stays 0
 * and the file-select screen reports "No valid Memory Card is inserted".
 *
 * Defining these symbols HERE resolves them at link time and the imports disappear.
 *
 * SYNCHRONOUS BY CONSTRUCTION
 * ---------------------------
 * Every CARD entry MP4 calls is the SDK's *synchronous* wrapper -- each is
 * `...Async(..., __CARDSyncCallback)` followed by `__CARDSync(chan)` (CARDMount.c:357,
 * CARDRead.c:141, CARDWrite.c:120, CARDCreate.c:118, CARDFormat.c:133, CARDStat.c:150,
 * CARDDelete.c:100, CARDCheck.c). VERIFIED: `grep -rnoE '\bCARD[A-Za-z]+Async\(' src
 * --include='*.c'` over the decomp, excluding src/dolphin/card/, returns NOTHING -- the game
 * calls no Async variant at all. So this shim does the work inline and returns the final
 * result; no completion-callback machinery is needed.
 *
 * The one callback in the API, CARDMount's 3rd argument, is the DETACH callback: CARDMount
 * (CARDMount.c:357) forwards it as CARDMountAsync's `detachCallback`, stored at
 * CARDMount.c:328 as card->extCallback. The game (game/card.c:65 -> MountCallBack) uses it
 * only to notice a card yanked mid-operation (`UnMountCnt & (1 << slot)`, saveload.c:765,
 * filesel.c:837). An emulated card is never removed, so it is stored and NEVER invoked.
 *
 * THE IMAGE IS A REAL 2 MiB .raw MEMORY CARD
 * ------------------------------------------
 * 16 Mbit = 2 MiB = 256 blocks x 8192 ("Memory Card 251": 251 usable + 5 system). System
 * blocks 0..4 = header, dir, dir-backup, FAT, FAT-backup. All metadata BIG-ENDIAN, checksums
 * exactly as __CARDCheckSum computes them (CARDCheck.c:11-28, including the
 * `if (sum == 0xffff) sum = 0` fixups on BOTH sum and inverse).
 *
 * Cross-checked field-for-field against Dolphin's own reader
 * (~/gc_refs/dolphin-upstream/Source/Core/Core/HW/GCMemcard/GCMemcard.{h,cpp}):
 *   - Header  : checksum area [0x000,0x1FC), size_mb at 0x22 must equal the file's implied
 *               Mbit, 0x026..0x1F9 and 0x200..0x1FFF must stay 0xFF (Header::CheckForErrors,
 *               GCMemcard.cpp:1288).
 *   - Directory: 127 x 0x40 DEntry, checkCode(update counter) at 0x1FFA, checksum area
 *               [0x0000,0x1FFC) (Directory::CalculateChecksums, GCMemcard.cpp:1339).
 *   - BlockAlloc(FAT): checksum@0, inv@2, updateCounter@4, freeBlocks@6, lastAlloc@8,
 *               map@0x0A (map[i] <-> block i+5); checksum area [0x0004,0x2000)
 *               (GCMemcard.cpp:632-643); map entries past the card's block count must be 0
 *               (BlockAlloc::CheckForErrors, GCMemcard.cpp:645).
 *   - CalculateMemcardChecksums (GCMemcard.cpp:326-348) is byte-identical in behaviour to
 *               __CARDCheckSum, 0xffff fixups included.
 * So an exported image opens in Dolphin's Memory Card Manager.
 *
 * CAVEAT, stated plainly: the file PAYLOAD the game writes is LITTLE-endian here (this is a
 * native port compiled for wasm, not a PowerPC emulation). The container is interoperable;
 * MP4's save contents are not readable by a real console or by the GC IPL.
 *
 * PORTABILITY: strict C89 (-std=gnu89) -- block comments only, declarations at block start.
 * The
 * decomp's stub <string.h> (include/string.h) declares only memcpy/memset/str*, NOT memcmp,
 * and its strcat is the bounded 3-arg SDK variant -- so every compare/copy below that is not
 * memcpy/memset is hand-rolled.
 */

#include <dolphin/card.h>
#include <string.h>

/* ------------------------------------------------------------------------- geometry */
/* memSize is Mbit: CARDProbeEx returns `id & 0xfc` (CARDMount.c:118) and IsCard
 * (CARDMount.c:50-58) admits only 4/8/16/32/64/128. sectorSize comes from
 * SectorSizeTable[(id & 0x3800) >> 11] whose entry 0 is 8*1024 (CARDMount.c:12-21).
 * 8192 is LOAD-BEARING: filesel.c:688,697 and saveload.c:737 reject anything else. */
#define GCC_SECTOR    8192
#define GCC_NBLOCK    256                    /* 16 Mbit * (1MiB / (8192*8)) = 256 */
#define GCC_SYSBLOCK  5                      /* CARD_NUM_SYSTEM_BLOCK */
#define GCC_MBIT      16
#define GCC_IMG_SIZE  (GCC_NBLOCK * GCC_SECTOR)
#define GCC_MAXFILE   CARD_MAX_FILE          /* 127 */
#define GCC_ENT       64                     /* sizeof(CARDDir), CARDPriv.h:23-42 */
#define GCC_SEG       CARD_READ_SIZE         /* 512 */

/* This build is GMPE01 (Mario Party 4 USA) -- build_wasm.sh:35 stages
 * $DECOMP/build/GMPE01_01/include. The recomp has no PPC low-memory map and stages no
 * DVDDiskID, so there is no card->diskID to read; the disc identity is fixed here.
 * CARDCreate stamps it into the dir entry (CARDCreate.c:23-25) and __CARDAccess matches on
 * it (CARDOpen.c:32-43). */
static const unsigned char GCC_GAME[4] = { 'G', 'M', 'P', 'E' };
static const unsigned char GCC_COMP[2] = { '0', '1' };

/* Fixed format time. Deliberately NOT the wall clock: CARDGetSerialNo is derived from
 * CARDID.serial, which the format routine seeds from the format time (CARDFormat.c:82-94),
 * and SLSerialNoCheck (saveload.c:593-609) ABORTS the save if the serial ever changes.
 * A constant here makes the serial identical across formats as well as across mounts, and
 * makes a freshly formatted image byte-reproducible. */
#define GCC_FORMAT_TIME  ((u64)0x0000000100000000)

/* -------------------------------------------------------------------------- storage */
static unsigned char gcc_img[GCC_IMG_SIZE];
static unsigned gcc_seq;              /* bumped on EVERY mutation; the host polls it */
static int gcc_dircur, gcc_fatcur;    /* which of the two copies holds the live content */
static int gcc_slots = 1;             /* bit0 = Slot A present, bit1 = Slot B */
static CARDCallback gcc_detach[2];    /* stored, never invoked (the card is never removed) */
static int gcc_ready;                 /* image has been adopted or formatted */
static u32 gcc_clock;                 /* host wall clock, seconds since 2000-01-01 */

#define BLK(n)        (gcc_img + (unsigned)(n) * GCC_SECTOR)
#define DIRB(i)       BLK(1 + (i))
#define FATB(i)       BLK(3 + (i))
#define DIRENT(c, n)  (DIRB(c) + (unsigned)(n) * GCC_ENT)

/* CARDDir field offsets (CARDPriv.h:23-42) */
#define E_GAME   0    /* u8[4]  */
#define E_COMP   4    /* u8[2]  */
#define E_PAD0   6    /* u8     */
#define E_BANNER 7    /* u8     */
#define E_NAME   8    /* u8[32] */
#define E_TIME   40   /* u32    */
#define E_ICONA  44   /* u32    */
#define E_ICONF  48   /* u16    */
#define E_ICONS  50   /* u16    */
#define E_PERM   52   /* u8     */
#define E_COPY   53   /* u8     */
#define E_START  54   /* u16    */
#define E_LEN    56   /* u16    */
#define E_PAD1   58   /* u8[2]  */
#define E_COMMA  60   /* u32    */

/* CARDDirCheck sits at &dir[127]; layout CARDPriv.h:44-50 (padding0[56], padding1,
 * checkCode, checkSum, checkSumInv). Dolphin calls checkCode the "update counter"
 * and puts it at 0x1FFA -- same byte (GCMemcard.h Directory). */
#define DIRCHK      (GCC_MAXFILE * GCC_ENT)   /* 8128 = 0x1FC0 */
#define DIRCHK_CODE (DIRCHK + 58)             /* 0x1FFA */
#define DIRCHK_SUM  (DIRCHK + 60)             /* 0x1FFC */
#define DIRCHK_INV  (DIRCHK + 62)             /* 0x1FFE */

/* FAT word indices (CARDPriv.h:8-13) */
#define FAT_SUM  0
#define FAT_INV  1
#define FAT_CODE 2
#define FAT_FREE 3
#define FAT_LAST 4

/* CARDID field offsets (dolsdk2001 include/dolphin/card.h:94-102; identical to Dolphin's
 * HeaderData, GCMemcard.h:160-188) */
#define ID_SERIAL 0     /* u8[32] */
#define ID_DEVICE 32    /* u16    */
#define ID_SIZE   34    /* u16, Mbit */
#define ID_ENCODE 36    /* u16    */
#define ID_SUM    508   /* u16    */
#define ID_INV    510   /* u16    */

/* ----------------------------------------- big-endian accessors (real card byte order) */
static u16 g16(const unsigned char *p)
{
    return (u16)(((u16)p[0] << 8) | (u16)p[1]);
}

static void p16(unsigned char *p, u16 v)
{
    p[0] = (unsigned char)(v >> 8);
    p[1] = (unsigned char)v;
}

static u32 g32(const unsigned char *p)
{
    return ((u32)p[0] << 24) | ((u32)p[1] << 16) | ((u32)p[2] << 8) | (u32)p[3];
}

static void p32(unsigned char *p, u32 v)
{
    p[0] = (unsigned char)(v >> 24);
    p[1] = (unsigned char)(v >> 16);
    p[2] = (unsigned char)(v >> 8);
    p[3] = (unsigned char)v;
}

static u16 fatg(int c, int i)
{
    return g16(FATB(c) + 2 * (unsigned)i);
}

static void fatp(int c, int i, u16 v)
{
    p16(FATB(c) + 2 * (unsigned)i, v);
}

/* the decomp's <string.h> has no memcmp */
static int gcc_eq(const unsigned char *a, const unsigned char *b, int n)
{
    int i;
    for (i = 0; i < n; i++) {
        if (a[i] != b[i]) {
            return 0;
        }
    }
    return 1;
}

static unsigned gcc_len(const char *s)
{
    unsigned n = 0;
    while (s[n] != '\0') {
        n++;
    }
    return n;
}

/* __CARDCheckSum, CARDCheck.c:11-28, over a BIG-ENDIAN u16 stream. The two 0xffff fixups
 * are part of the on-card contract -- Dolphin applies the identical pair
 * (GCMemcard.cpp:342-345) and rejects the block without them. */
static void gcc_cksum(const unsigned char *p, int len, u16 *sum, u16 *inv)
{
    u16 s = 0;
    u16 si = 0;
    int i;
    int n = len / 2;
    for (i = 0; i < n; i++, p += 2) {
        u16 v = g16(p);
        s = (u16)(s + v);
        si = (u16)(si + (u16)(v ^ 0xffff));
    }
    if (s == 0xffff) {
        s = 0;
    }
    if (si == 0xffff) {
        si = 0;
    }
    *sum = s;
    *inv = si;
}

/* ---------------------------------------------------------------- commit helpers */
/* __CARDUpdateDir (CARDDir.c:78-100) + its WriteCallback (CARDDir.c:15-42): bump checkCode,
 * re-checksum over 0x2000-4 from offset 0, write, then swap the "current" pointer to the
 * other block and memcpy the just-written content across -- so BOTH copies always end up
 * byte-identical after a commit. */
static void gcc_dir_commit(void)
{
    unsigned char *d = DIRB(gcc_dircur);
    u16 sum, inv;
    p16(d + DIRCHK_CODE, (u16)(g16(d + DIRCHK_CODE) + 1));
    gcc_cksum(d, GCC_SECTOR - 4, &sum, &inv);
    p16(d + DIRCHK_SUM, sum);
    p16(d + DIRCHK_INV, inv);
    memcpy(DIRB(gcc_dircur ^ 1), d, GCC_SECTOR);
    gcc_dircur ^= 1;
    gcc_seq++;
}

/* __CARDUpdateFatBlock (CARDBlock.c:155-171): ++fat[2], checksum over &fat[2] for 0x1FFC
 * bytes, then the same alternate-and-mirror as the directory (CARDBlock.c:15-45). */
static void gcc_fat_commit(void)
{
    unsigned char *f = FATB(gcc_fatcur);
    u16 sum, inv;
    p16(f + 2 * FAT_CODE, (u16)(fatg(gcc_fatcur, FAT_CODE) + 1));
    gcc_cksum(f + 4, GCC_SECTOR - 4, &sum, &inv);
    p16(f + 2 * FAT_SUM, sum);
    p16(f + 2 * FAT_INV, inv);
    memcpy(FATB(gcc_fatcur ^ 1), f, GCC_SECTOR);
    gcc_fatcur ^= 1;
    gcc_seq++;
}

/* ------------------------------------------------------------------- formatting */
/* __CARDFormatRegionAsync, CARDFormat.c:52-127. */
static void gcc_format_image(u16 encode)
{
    unsigned char *id = BLK(0);
    u16 sum, inv;
    int i;

    /* Erased flash reads back 0xff; the SDK memsets the whole 8 KiB system block, which is
     * also what keeps Dolphin's "unused area must be 0xFF" check happy (GCMemcard.cpp:1295). */
    memset(id, 0xff, GCC_SECTOR);

    /* CARDID.serial[32] = 12 scrambled flashID bytes, the format time (OSTime, 8 bytes at
     * serial[12]), SRAM counterBias at [20], SRAM language at [24], VI DTV status at [28]
     * (CARDFormat.c:75-94). Nothing in THIS shim validates them, but generating them with
     * the SDK's exact LCG keeps the image consistent with what a console would have written
     * (VerifyID re-runs the same LCG, CARDCheck.c:51-61) and gives CARDGetSerialNo a
     * non-degenerate value to XOR. */
    {
        static const char flashID[12] = { 'B','E','M','E','N','T','A','L','S','L','T','A' };
        u64 rnd = GCC_FORMAT_TIME;
        for (i = 0; i < 12; i++) {
            rnd = ((rnd * (u64)1103515245) + (u64)12345) >> 16;
            id[ID_SERIAL + i] = (unsigned char)((unsigned)flashID[i] + (unsigned)rnd);
            rnd = (((rnd * (u64)1103515245) + (u64)12345) >> 16) & (u64)0x7fff;
        }
        p32(id + ID_SERIAL + 12, (u32)(GCC_FORMAT_TIME >> 32));
        p32(id + ID_SERIAL + 16, (u32)GCC_FORMAT_TIME);
        p32(id + ID_SERIAL + 20, 0);   /* SRAM counterBias -- written, never read back */
        p32(id + ID_SERIAL + 24, 0);   /* SRAM language    -- written, never read back */
        p32(id + ID_SERIAL + 28, 0);   /* VI DTV status    -- written, never read back */
    }
    p16(id + ID_DEVICE, 0);            /* VerifyID demands 0 (CARDCheck.c:40) */
    p16(id + ID_SIZE, GCC_MBIT);       /* must equal card->size / the file's implied Mbit */
    p16(id + ID_ENCODE, encode);       /* 0 = ANSI (CARD_ENCODE_ANSI) */
    gcc_cksum(id, ID_SUM, &sum, &inv);
    p16(id + ID_SUM, sum);
    p16(id + ID_INV, inv);

    for (i = 0; i < 2; i++) {
        unsigned char *d = DIRB(i);
        memset(d, 0xff, GCC_SECTOR);
        p16(d + DIRCHK_CODE, (u16)i);
        gcc_cksum(d, GCC_SECTOR - 4, &sum, &inv);
        p16(d + DIRCHK_SUM, sum);
        p16(d + DIRCHK_INV, inv);
    }
    for (i = 0; i < 2; i++) {
        unsigned char *f = FATB(i);
        memset(f, 0x00, GCC_SECTOR);
        p16(f + 2 * FAT_CODE, (u16)i);
        p16(f + 2 * FAT_FREE, (u16)(GCC_NBLOCK - GCC_SYSBLOCK));
        p16(f + 2 * FAT_LAST, (u16)(GCC_SYSBLOCK - 1));
        gcc_cksum(f + 4, GCC_SECTOR - 4, &sum, &inv);
        p16(f + 2 * FAT_SUM, sum);
        p16(f + 2 * FAT_INV, inv);
    }
    memset(BLK(GCC_SYSBLOCK), 0xff,
           (unsigned)(GCC_NBLOCK - GCC_SYSBLOCK) * GCC_SECTOR);

    /* Both copies are valid and copy 1 carries the higher checkCode, so it is the live one
     * (VerifyDir/VerifyFAT, CARDCheck.c:88-96 / 148-156, pick by checkCode difference). */
    gcc_dircur = 1;
    gcc_fatcur = 1;
    gcc_ready = 1;
    gcc_seq++;
}

/* ------------------------------------------------------------------- validation */
static int gcc_hdr_ok(void)
{
    const unsigned char *id = BLK(0);
    u16 sum, inv;
    if (g16(id + ID_DEVICE) != 0) {
        return 0;
    }
    if (g16(id + ID_SIZE) != GCC_MBIT) {
        return 0;
    }
    gcc_cksum(id, ID_SUM, &sum, &inv);
    return (g16(id + ID_SUM) == sum && g16(id + ID_INV) == inv);
}

static int gcc_dir_ok(int i)
{
    const unsigned char *d = DIRB(i);
    u16 sum, inv;
    gcc_cksum(d, GCC_SECTOR - 4, &sum, &inv);
    return (g16(d + DIRCHK_SUM) == sum && g16(d + DIRCHK_INV) == inv);
}

/* VerifyFAT also cross-checks the free-block count against the map (CARDCheck.c:132-144). */
static int gcc_fat_ok(int i)
{
    const unsigned char *f = FATB(i);
    u16 sum, inv;
    u16 nfree = 0;
    int b;
    gcc_cksum(f + 4, GCC_SECTOR - 4, &sum, &inv);
    if (g16(f + 2 * FAT_SUM) != sum || g16(f + 2 * FAT_INV) != inv) {
        return 0;
    }
    for (b = GCC_SYSBLOCK; b < GCC_NBLOCK; b++) {
        if (fatg(i, b) == 0) {
            nfree++;
        }
    }
    return (nfree == fatg(i, FAT_FREE));
}

/* Adopt whatever bytes the host injected into gcc_img. Returns 1 if the image is usable.
 * Mirrors __CARDVerify -> VerifyID/VerifyDir/VerifyFAT (CARDCheck.c:30-165): pick the copy
 * with the HIGHER checkCode as the live content, then heal the other from it so the image
 * stays self-consistent for the next export. (The SDK names the STALE slot "current" and
 * memcpy's the newer content INTO it; the data outcome is identical, only the index differs,
 * and the index never leaves this file.) */
int __recomp_card_adopt(void)
{
    int d0, d1, f0, f1;

    if (!gcc_hdr_ok()) {
        gcc_ready = 0;
        return 0;
    }
    d0 = gcc_dir_ok(0);
    d1 = gcc_dir_ok(1);
    f0 = gcc_fat_ok(0);
    f1 = gcc_fat_ok(1);
    if (!(d0 || d1) || !(f0 || f1)) {
        gcc_ready = 0;
        return 0;
    }
    if (d0 && d1) {
        int c0 = (int)(s16)g16(DIRB(0) + DIRCHK_CODE);
        int c1 = (int)(s16)g16(DIRB(1) + DIRCHK_CODE);
        gcc_dircur = ((c0 - c1) < 0) ? 1 : 0;
    } else {
        gcc_dircur = d0 ? 0 : 1;
    }
    if (f0 && f1) {
        int c0 = (int)(s16)fatg(0, FAT_CODE);
        int c1 = (int)(s16)fatg(1, FAT_CODE);
        gcc_fatcur = ((c0 - c1) < 0) ? 1 : 0;
    } else {
        gcc_fatcur = f0 ? 0 : 1;
    }
    memcpy(DIRB(gcc_dircur ^ 1), DIRB(gcc_dircur), GCC_SECTOR);
    memcpy(FATB(gcc_fatcur ^ 1), FATB(gcc_fatcur), GCC_SECTOR);
    gcc_ready = 1;
    return 1;
}

/* --------------------------------------------------------------- small helpers */
static int gcc_present(s32 chan)
{
    return (chan >= 0 && chan < 2 && (gcc_slots & (1 << chan)) != 0);
}

/* __CARDCompareFileName, CARDOpen.c:8-30 */
static int gcc_name_eq(const unsigned char *ent, const char *name)
{
    const char *e = (const char *)(ent + E_NAME);
    int n = CARD_FILENAME_MAX;
    while (--n >= 0) {
        char c1 = *e++;
        char c2 = *name++;
        if (c1 != c2) {
            return 0;
        }
        if (c2 == '\0') {
            return 1;
        }
    }
    return (*name == '\0');
}

/* __CARDAccess, CARDOpen.c:32-43: 0xff gameName[0] = free slot; otherwise the disc identity
 * must match (our card->diskID is never __CARDDiskNone). */
static int gcc_ours(const unsigned char *ent)
{
    return (gcc_eq(ent + E_GAME, GCC_GAME, 4) && gcc_eq(ent + E_COMP, GCC_COMP, 2));
}

/* __CARDGetFileNo, CARDOpen.c:59-83 */
static int gcc_find(const char *name)
{
    int i;
    for (i = 0; i < GCC_MAXFILE; i++) {
        const unsigned char *ent = DIRENT(gcc_dircur, i);
        if (ent[E_GAME] == 0xff) {
            continue;
        }
        if (!gcc_ours(ent)) {
            continue;
        }
        if (gcc_name_eq(ent, name)) {
            return i;
        }
    }
    return -1;
}

/* __CARDFreeBlock, CARDBlock.c:130-153 */
static void gcc_free_chain(u16 start)
{
    u16 b = start;
    int guard = GCC_NBLOCK;
    while (b != 0xffff && guard-- > 0) {
        u16 next;
        if (b < GCC_SYSBLOCK || b >= GCC_NBLOCK) {
            break;
        }
        next = fatg(gcc_fatcur, b);
        fatp(gcc_fatcur, b, 0);
        fatp(gcc_fatcur, FAT_FREE, (u16)(fatg(gcc_fatcur, FAT_FREE) + 1));
        b = next;
    }
}

/* UpdateIconOffsets, CARDStat.c:10-66. Reads the format bits from the DIR ENTRY (not from
 * stat) exactly as the SDK does -- the 0xffffffff-iconAddr branch zeroes stat's copies but
 * the switch still runs on the entry's values. */
static void gcc_icon_offsets(const unsigned char *ent, CARDStat *stat)
{
    u32 offset = g32(ent + E_ICONA);
    u16 iconFmt = g16(ent + E_ICONF);
    int iconTlut = 0;
    int i;

    if (offset == 0xffffffffu) {
        stat->bannerFormat = 0;
        stat->iconFormat = 0;
        stat->iconSpeed = 0;
        offset = 0;
    }

    switch (ent[E_BANNER] & CARD_STAT_BANNER_MASK) {
    case CARD_STAT_BANNER_C8:
        stat->offsetBanner = offset;
        offset += CARD_BANNER_WIDTH * CARD_BANNER_HEIGHT;
        stat->offsetBannerTlut = offset;
        offset += 2 * 256;
        break;
    case CARD_STAT_BANNER_RGB5A3:
        stat->offsetBanner = offset;
        offset += 2 * CARD_BANNER_WIDTH * CARD_BANNER_HEIGHT;
        stat->offsetBannerTlut = 0xffffffffu;
        break;
    default:
        stat->offsetBanner = 0xffffffffu;
        stat->offsetBannerTlut = 0xffffffffu;
        break;
    }
    for (i = 0; i < CARD_ICON_MAX; i++) {
        switch ((iconFmt >> (2 * i)) & CARD_STAT_ICON_MASK) {
        case CARD_STAT_ICON_C8:
            stat->offsetIcon[i] = offset;
            offset += CARD_ICON_WIDTH * CARD_ICON_HEIGHT;
            iconTlut = 1;
            break;
        case CARD_STAT_ICON_RGB5A3:
            stat->offsetIcon[i] = offset;
            offset += 2 * CARD_ICON_WIDTH * CARD_ICON_HEIGHT;
            break;
        default:
            stat->offsetIcon[i] = 0xffffffffu;
            break;
        }
    }
    if (iconTlut) {
        stat->offsetIconTlut = offset;
        offset += 2 * 256;
    } else {
        stat->offsetIconTlut = 0xffffffffu;
    }
    stat->offsetData = offset;
}

/* ============================================================== CARD public API */

void CARDInit(void)
{
    if (gcc_ready) {
        return;
    }
    /* The host seeds a persisted image into [base, base+size) BEFORE Module._main(), and
     * CARDInit runs inside main (HuCardInit, game/card.c:11-15). Adopt it if it validates;
     * otherwise lay down a fresh formatted card so the game sees a working empty slot
     * (CARDOpen then returns NOFILE -- the normal "no save yet" path, saveload.c:71). */
    if (!__recomp_card_adopt()) {
        gcc_format_image(CARD_ENCODE_ANSI);
    }
}

/* CARDProbeEx, CARDMount.c:75-140. Chan out of range -> FATAL_ERROR; no card -> NOCARD;
 * otherwise memSize (Mbit) and sectorSize are written and READY returned. Works with the
 * card UNMOUNTED (the !card->attached path via EXIGetID/IsCard) -- filesel.c:688,697 and
 * HuCardCheck (game/card.c:22-24) both call it before any mount. */
s32 CARDProbeEx(s32 chan, s32 *memSize, s32 *sectorSize)
{
    if (chan < 0 || chan >= 2) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (memSize) {
        *memSize = GCC_MBIT;
    }
    if (sectorSize) {
        *sectorSize = GCC_SECTOR;
    }
    return CARD_RESULT_READY;
}

BOOL CARDProbe(s32 chan)
{
    return (BOOL)gcc_present(chan);
}

/* CARDMount, CARDMount.c:357-365. The 3rd argument is the DETACH callback (forwarded to
 * CARDMountAsync's detachCallback, stored at CARDMount.c:328 as card->extCallback). Stored
 * and never called: the emulated card is never removed, so UnMountCnt (game/card.c:100-107)
 * stays 0 and the game's "card yanked" branches are never taken. */
s32 CARDMount(s32 chan, void *workArea, CARDCallback detachCallback)
{
    (void)workArea;
    if (chan < 0 || chan >= 2) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    gcc_detach[chan] = detachCallback;
    if (!gcc_ready && !__recomp_card_adopt()) {
        return CARD_RESULT_BROKEN;
    }
    return CARD_RESULT_READY;
}

s32 CARDMountAsync(s32 chan, void *workArea, CARDCallback detachCallback,
                   CARDCallback attachCallback)
{
    s32 r = CARDMount(chan, workArea, detachCallback);
    if (attachCallback) {
        attachCallback(chan, r);
    }
    return r;
}

/* Deliberately tears nothing down. The SDK detaches the control block so every later call
 * returns NOCARD; here the card stays reachable, which can only turn a game error path into
 * a success path (saveload.c and filesel.c unmount as cleanup and re-mount before the next
 * operation). Note it does NOT bump gcc_seq: unmount changes no bytes, and the game unmounts
 * on every file-select entry/exit -- bumping here would make the host snapshot and re-write
 * 2 MiB to IndexedDB for nothing. Every path that actually mutates the image (format, write,
 * dir commit, FAT commit) bumps it. */
s32 CARDUnmount(s32 chan)
{
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    return CARD_RESULT_READY;
}

s32 CARDCheck(s32 chan)
{
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready && !__recomp_card_adopt()) {
        return CARD_RESULT_BROKEN;
    }
    return CARD_RESULT_READY;
}

s32 CARDCheckAsync(s32 chan, CARDCallback callback)
{
    s32 r = CARDCheck(chan);
    if (callback) {
        callback(chan, r);
    }
    return r;
}

s32 CARDCheckEx(s32 chan, s32 *xferBytes)
{
    if (xferBytes) {
        *xferBytes = 0;
    }
    return CARDCheck(chan);
}

s32 CARDCheckExAsync(s32 chan, s32 *xferBytes, CARDCallback callback)
{
    s32 r = CARDCheckEx(chan, xferBytes);
    if (callback) {
        callback(chan, r);
    }
    return r;
}

s32 CARDFormat(s32 chan)
{
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    gcc_format_image(CARD_ENCODE_ANSI);
    return CARD_RESULT_READY;
}

s32 CARDFormatAsync(s32 chan, CARDCallback callback)
{
    s32 r = CARDFormat(chan);
    if (callback) {
        callback(chan, r);
    }
    return r;
}

/* CARDGetSectorSize, CARDBios.c:578-589. saveload.c:737 (SLCardMount) rejects anything but
 * 8192 with CARD_RESULT_WRONGDEVICE, and HuCardCreate (game/card.c:135) divides by it. */
s32 CARDGetSectorSize(s32 chan, u32 *size)
{
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (size) {
        *size = GCC_SECTOR;
    }
    return CARD_RESULT_READY;
}

s32 CARDGetMemSize(s32 chan, u16 *size)
{
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (size) {
        *size = GCC_MBIT;
    }
    return CARD_RESULT_READY;
}

s32 CARDGetEncoding(s32 chan, u16 *encode)
{
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (encode) {
        *encode = g16(BLK(0) + ID_ENCODE);
    }
    return CARD_RESULT_READY;
}

/* CARDGetSerialNo, CARDNet.c:10-34: XOR of the four u64s in CARDID.serial[32], read from
 * card->workArea (the header block loaded at mount). Here it is read straight from block 0,
 * which is what makes it STABLE across mounts -- SLSerialNoCheck (saveload.c:593-609) aborts
 * the save if the value ever changes between two calls. It is also stable across FORMATS,
 * because the serial is seeded from the fixed GCC_FORMAT_TIME. */
s32 CARDGetSerialNo(s32 chan, u64 *serialNo)
{
    const unsigned char *id = BLK(0) + ID_SERIAL;
    u64 code = 0;
    int i;

    if (chan < 0 || chan >= 2) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    for (i = 0; i < 4; i++) {
        u64 hi = (u64)g32(id + 8 * i);
        u64 lo = (u64)g32(id + 8 * i + 4);
        code ^= (hi << 32) | lo;
    }
    if (serialNo) {
        *serialNo = code;
    }
    return CARD_RESULT_READY;
}

/* CARDFreeBlocks, CARDBios.c:541-576. filesNotUsed counts entries whose fileName[0] is 0xff
 * (NOT gameName[0]) -- CARDBios.c:565-568. */
s32 CARDFreeBlocks(s32 chan, s32 *byteNotUsed, s32 *filesNotUsed)
{
    int i;
    int nfree = 0;

    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    if (byteNotUsed) {
        *byteNotUsed = (s32)fatg(gcc_fatcur, FAT_FREE) * GCC_SECTOR;
    }
    for (i = 0; i < GCC_MAXFILE; i++) {
        if (DIRENT(gcc_dircur, i)[E_NAME] == 0xff) {
            nfree++;
        }
    }
    if (filesNotUsed) {
        *filesNotUsed = nfree;
    }
    return CARD_RESULT_READY;
}

/* CARDOpen, CARDOpen.c:85-113. Returns CARD_RESULT_NOFILE (-4) when the file is absent --
 * that is the NORMAL "no save yet" path (saveload.c:71-73 returns it verbatim, and
 * saveload.c:412 branches on it to offer file creation). */
s32 CARDOpen(s32 chan, const char *fileName, CARDFileInfo *fileInfo)
{
    int no;
    const unsigned char *ent;
    u16 start;

    if (fileInfo) {
        fileInfo->chan = -1;
    }
    if (chan < 0 || chan >= 2) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    if (!fileName || !fileInfo) {
        return CARD_RESULT_FATAL_ERROR;
    }
    no = gcc_find(fileName);
    if (no < 0) {
        return CARD_RESULT_NOFILE;
    }
    ent = DIRENT(gcc_dircur, no);
    start = g16(ent + E_START);
    if (start < GCC_SYSBLOCK || start >= GCC_NBLOCK) {   /* CARDIsValidBlockNo */
        return CARD_RESULT_BROKEN;
    }
    fileInfo->chan = chan;
    fileInfo->fileNo = no;
    fileInfo->offset = 0;
    fileInfo->iBlock = start;
    return CARD_RESULT_READY;
}

s32 CARDFastOpen(s32 chan, s32 fileNo, CARDFileInfo *fileInfo)
{
    const unsigned char *ent;
    u16 start;

    if (fileNo < 0 || fileNo >= GCC_MAXFILE) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    if (!fileInfo) {
        return CARD_RESULT_FATAL_ERROR;
    }
    ent = DIRENT(gcc_dircur, fileNo);
    if (ent[E_GAME] == 0xff) {
        return CARD_RESULT_NOFILE;
    }
    start = g16(ent + E_START);
    if (start < GCC_SYSBLOCK || start >= GCC_NBLOCK) {
        return CARD_RESULT_BROKEN;
    }
    fileInfo->chan = chan;
    fileInfo->fileNo = fileNo;
    fileInfo->offset = 0;
    fileInfo->iBlock = start;
    return CARD_RESULT_READY;
}

/* CARDClose, CARDOpen.c:115-127 */
s32 CARDClose(CARDFileInfo *fileInfo)
{
    if (!fileInfo) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (fileInfo->chan < 0 || fileInfo->chan >= 2) {
        return CARD_RESULT_NOCARD;
    }
    fileInfo->chan = -1;
    return CARD_RESULT_READY;
}

s32 CARDCancel(CARDFileInfo *fileInfo)
{
    (void)fileInfo;
    return CARD_RESULT_READY;
}

/* CARDCreateAsync (CARDCreate.c:54-116) + __CARDAllocBlock (CARDBlock.c:81-127) +
 * CreateCallbackFat (CARDCreate.c:8-52), collapsed into one synchronous step.
 * MP4 creates "MARIPA4BOX0..2" at 16384 bytes = 2 blocks (saveload.c:418, saveload.h:6). */
s32 CARDCreate(s32 chan, const char *fileName, u32 size, CARDFileInfo *fileInfo)
{
    int i;
    int freeNo = -1;
    int guard;
    u32 nblk;
    u32 got = 0;
    u16 cur;
    u16 prev = 0;
    u16 start = 0xffff;
    unsigned char *ent;

    if (chan < 0 || chan >= 2) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!fileName || !fileInfo) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (gcc_len(fileName) > (unsigned)CARD_FILENAME_MAX) {
        return CARD_RESULT_NAMETOOLONG;    /* CARDCreate.c:62-64, checked before anything */
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    if (size == 0 || (size % GCC_SECTOR) != 0) {
        return CARD_RESULT_FATAL_ERROR;    /* CARDCreate.c:71-73 */
    }

    for (i = 0; i < GCC_MAXFILE; i++) {
        ent = DIRENT(gcc_dircur, i);
        if (ent[E_GAME] == 0xff) {
            if (freeNo < 0) {
                freeNo = i;
            }
            continue;
        }
        if (gcc_ours(ent) && gcc_name_eq(ent, fileName)) {
            return CARD_RESULT_EXIST;
        }
    }
    if (freeNo < 0) {
        return CARD_RESULT_NOENT;
    }

    nblk = size / GCC_SECTOR;
    if ((u32)fatg(gcc_fatcur, FAT_FREE) < nblk) {
        return CARD_RESULT_INSSPACE;
    }

    /* __CARDAllocBlock: walk forward from lastSlot, wrapping to block 5, taking every
     * FAT_AVAIL(0) slot and chaining it; the last gets 0xffff. */
    cur = fatg(gcc_fatcur, FAT_LAST);
    guard = GCC_NBLOCK * 2;
    while (got < nblk) {
        if (--guard < 0) {
            return CARD_RESULT_BROKEN;
        }
        cur = (u16)(cur + 1);
        if (cur < GCC_SYSBLOCK || cur >= GCC_NBLOCK) {
            cur = GCC_SYSBLOCK;
        }
        if (fatg(gcc_fatcur, cur) != 0) {
            continue;
        }
        if (start == 0xffff) {
            start = cur;
        } else {
            fatp(gcc_fatcur, prev, cur);
        }
        prev = cur;
        fatp(gcc_fatcur, cur, 0xffff);
        got++;
    }
    fatp(gcc_fatcur, FAT_LAST, cur);
    fatp(gcc_fatcur, FAT_FREE, (u16)(fatg(gcc_fatcur, FAT_FREE) - (u16)nblk));
    gcc_fat_commit();

    /* dir entry: CARDCreate.c:22-41 + CARDCreate.c:100-101 (length, fileName). The padding
     * bytes read 0xff on a formatted card (the SDK never writes them, and both format and
     * delete leave the entry 0xff-filled) -- Dolphin documents them as always-0xff
     * (GCMemcard.h DEntry m_unused_1 / m_unused_2). */
    ent = DIRENT(gcc_dircur, freeNo);
    memset(ent, 0xff, GCC_ENT);
    memcpy(ent + E_GAME, GCC_GAME, 4);
    memcpy(ent + E_COMP, GCC_COMP, 2);
    ent[E_PAD0] = 0xff;
    ent[E_BANNER] = 0;
    /* The SDK uses its bounded strcat(dst, src, max) here; the intended result is the
     * NUL-terminated, zero-padded name that __CARDCompareFileName and Dolphin's DEntry
     * both expect, so write that directly. */
    memset(ent + E_NAME, 0, CARD_FILENAME_MAX);
    {
        unsigned n = gcc_len(fileName);
        if (n > (unsigned)CARD_FILENAME_MAX) {
            n = (unsigned)CARD_FILENAME_MAX;
        }
        memcpy(ent + E_NAME, fileName, n);
    }
    p32(ent + E_TIME, gcc_clock);
    p32(ent + E_ICONA, 0xffffffffu);
    p16(ent + E_ICONF, 0);
    p16(ent + E_ICONS, CARD_STAT_SPEED_FAST);   /* CARDSetIconSpeed(ent, 0, FAST) */
    ent[E_PERM] = CARD_ATTR_PUBLIC;
    ent[E_COPY] = 0;
    p16(ent + E_START, start);
    p16(ent + E_LEN, (u16)nblk);
    ent[E_PAD1] = 0xff;
    ent[E_PAD1 + 1] = 0xff;
    p32(ent + E_COMMA, 0xffffffffu);
    gcc_dir_commit();

    fileInfo->chan = chan;
    fileInfo->fileNo = freeNo;
    fileInfo->offset = 0;
    fileInfo->iBlock = start;
    return CARD_RESULT_READY;
}

s32 CARDCreateAsync(s32 chan, const char *fileName, u32 size, CARDFileInfo *fileInfo,
                    CARDCallback cb)
{
    s32 r = CARDCreate(chan, fileName, size, fileInfo);
    if (cb) {
        cb(chan, r);
    }
    return r;
}

/* CARDFastDeleteAsync, CARDDelete.c:35-67: capture startBlock, memset the entry to 0xff,
 * update the dir, then free the block chain. */
s32 CARDFastDelete(s32 chan, s32 fileNo)
{
    unsigned char *ent;

    if (fileNo < 0 || fileNo >= GCC_MAXFILE) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    ent = DIRENT(gcc_dircur, fileNo);
    if (ent[E_GAME] == 0xff) {
        return CARD_RESULT_NOFILE;
    }
    if (!gcc_ours(ent)) {
        return CARD_RESULT_NOPERM;
    }
    gcc_free_chain(g16(ent + E_START));
    gcc_fat_commit();
    memset(ent, 0xff, GCC_ENT);
    gcc_dir_commit();
    return CARD_RESULT_READY;
}

s32 CARDFastDeleteAsync(s32 chan, s32 fileNo, CARDCallback cb)
{
    s32 r = CARDFastDelete(chan, fileNo);
    if (cb) {
        cb(chan, r);
    }
    return r;
}

s32 CARDDelete(s32 chan, const char *fileName)
{
    int no;

    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    if (!fileName) {
        return CARD_RESULT_FATAL_ERROR;
    }
    no = gcc_find(fileName);
    if (no < 0) {
        return CARD_RESULT_NOFILE;
    }
    return CARDFastDelete(chan, no);
}

s32 CARDDeleteAsync(s32 chan, const char *fileName, CARDCallback cb)
{
    s32 r = CARDDelete(chan, fileName);
    if (cb) {
        cb(chan, r);
    }
    return r;
}

/* __CARDSeek + the FAT chain walk behind CARDReadAsync/CARDWriteAsync. Alignment is the
 * SDK's: reads must be CARD_SEG_SIZE(512)-aligned in BOTH offset and length
 * (CARDRead.c:109-111), writes sectorSize(8192)-aligned (CARDWrite.c:99-101). MP4 reads and
 * writes 16384 at offset 0 (saveload.c:442,541), so both rules hold. */
static s32 gcc_rw(CARDFileInfo *fi, void *buf, s32 length, s32 offset, int wr)
{
    unsigned char *p = (unsigned char *)buf;
    const unsigned char *ent;
    s32 flen;
    s32 pos = 0;
    u16 blk;

    if (!fi || !buf) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (fi->chan < 0 || fi->chan >= 2) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_present(fi->chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    if (fi->fileNo < 0 || fi->fileNo >= GCC_MAXFILE) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (length <= 0 || offset < 0) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (wr) {
        if ((offset % GCC_SECTOR) != 0 || (length % GCC_SECTOR) != 0) {
            return CARD_RESULT_FATAL_ERROR;
        }
    } else {
        if ((offset % GCC_SEG) != 0 || (length % GCC_SEG) != 0) {
            return CARD_RESULT_FATAL_ERROR;
        }
    }

    ent = DIRENT(gcc_dircur, fi->fileNo);
    if (ent[E_GAME] == 0xff) {
        return CARD_RESULT_NOFILE;
    }
    /* __CARDAccess, falling back to __CARDIsPublic for reads (CARDRead.c:117-120); writes
     * take no public fallback (CARDWrite.c:105-109). */
    if (!gcc_ours(ent)) {
        if (wr || (ent[E_PERM] & CARD_ATTR_PUBLIC) == 0) {
            return CARD_RESULT_NOPERM;
        }
    }

    flen = (s32)g16(ent + E_LEN) * GCC_SECTOR;
    if (offset >= flen || offset + length > flen) {
        return CARD_RESULT_LIMIT;
    }

    blk = g16(ent + E_START);
    while (pos + GCC_SECTOR <= offset) {
        if (blk < GCC_SYSBLOCK || blk >= GCC_NBLOCK) {
            return CARD_RESULT_BROKEN;
        }
        blk = fatg(gcc_fatcur, blk);
        pos += GCC_SECTOR;
    }
    while (length > 0) {
        s32 inblk = offset - pos;
        s32 n = GCC_SECTOR - inblk;
        if (n > length) {
            n = length;
        }
        if (blk < GCC_SYSBLOCK || blk >= GCC_NBLOCK) {
            return CARD_RESULT_BROKEN;
        }
        if (wr) {
            memcpy(BLK(blk) + inblk, p, (unsigned)n);
        } else {
            memcpy(p, BLK(blk) + inblk, (unsigned)n);
        }
        p += n;
        offset += n;
        length -= n;
        if (offset - pos >= GCC_SECTOR) {
            blk = fatg(gcc_fatcur, blk);
            pos += GCC_SECTOR;
        }
    }
    fi->offset = offset;
    fi->iBlock = blk;
    if (wr) {
        gcc_seq++;
    }
    return CARD_RESULT_READY;
}

s32 CARDRead(CARDFileInfo *fileInfo, void *addr, s32 length, s32 offset)
{
    return gcc_rw(fileInfo, addr, length, offset, 0);
}

s32 CARDReadAsync(CARDFileInfo *fileInfo, void *addr, s32 length, s32 offset, CARDCallback cb)
{
    s32 r = CARDRead(fileInfo, addr, length, offset);
    if (cb) {
        cb(fileInfo ? fileInfo->chan : 0, r);
    }
    return r;
}

s32 CARDWrite(CARDFileInfo *fileInfo, const void *addr, s32 length, s32 offset)
{
    return gcc_rw(fileInfo, (void *)addr, length, offset, 1);
}

s32 CARDWriteAsync(CARDFileInfo *fileInfo, const void *addr, s32 length, s32 offset,
                   CARDCallback cb)
{
    s32 r = CARDWrite(fileInfo, addr, length, offset);
    if (cb) {
        cb(fileInfo ? fileInfo->chan : 0, r);
    }
    return r;
}

/* CARDGetStatus, CARDStat.c:68-104 */
s32 CARDGetStatus(s32 chan, s32 fileNo, CARDStat *stat)
{
    const unsigned char *ent;

    if (fileNo < 0 || fileNo >= GCC_MAXFILE) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    if (!stat) {
        return CARD_RESULT_FATAL_ERROR;
    }
    ent = DIRENT(gcc_dircur, fileNo);
    if (ent[E_GAME] == 0xff) {
        return CARD_RESULT_NOFILE;
    }
    if (!gcc_ours(ent) && (ent[E_PERM] & CARD_ATTR_PUBLIC) == 0) {
        return CARD_RESULT_NOPERM;
    }

    memcpy(stat->gameName, ent + E_GAME, 4);
    memcpy(stat->company, ent + E_COMP, 2);
    stat->length = (u32)g16(ent + E_LEN) * GCC_SECTOR;
    memcpy(stat->fileName, ent + E_NAME, CARD_FILENAME_MAX);
    stat->time = g32(ent + E_TIME);
    stat->bannerFormat = ent[E_BANNER];
    stat->iconAddr = g32(ent + E_ICONA);
    stat->iconFormat = g16(ent + E_ICONF);
    stat->iconSpeed = g16(ent + E_ICONS);
    stat->commentAddr = g32(ent + E_COMMA);
    gcc_icon_offsets(ent, stat);
    return CARD_RESULT_READY;
}

/* CARDSetStatusAsync, CARDStat.c:106-148. MP4 calls this from SLStatSet (saveload.c) with
 * commentAddr=0, iconAddr=64, banner C8, 4 C8 icons at MIDDLE speed. */
s32 CARDSetStatus(s32 chan, s32 fileNo, CARDStat *stat)
{
    unsigned char *ent;

    if (fileNo < 0 || fileNo >= GCC_MAXFILE) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!stat) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (stat->iconAddr != 0xffffffffu && stat->iconAddr >= (u32)CARD_READ_SIZE) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (stat->commentAddr != 0xffffffffu &&
        (stat->commentAddr % (u32)GCC_SECTOR) > (u32)(GCC_SECTOR - CARD_COMMENT_SIZE)) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    ent = DIRENT(gcc_dircur, fileNo);
    if (ent[E_GAME] == 0xff) {
        return CARD_RESULT_NOFILE;
    }
    if (!gcc_ours(ent)) {
        return CARD_RESULT_NOPERM;
    }

    ent[E_BANNER] = stat->bannerFormat;
    p32(ent + E_ICONA, stat->iconAddr);
    p16(ent + E_ICONF, stat->iconFormat);
    p16(ent + E_ICONS, stat->iconSpeed);
    p32(ent + E_COMMA, stat->commentAddr);
    gcc_icon_offsets(ent, stat);
    if (g32(ent + E_ICONA) == 0xffffffffu) {
        p16(ent + E_ICONS,
            (u16)((g16(ent + E_ICONS) & ~CARD_STAT_SPEED_MASK) | CARD_STAT_SPEED_FAST));
    }
    p32(ent + E_TIME, gcc_clock);
    gcc_dir_commit();
    return CARD_RESULT_READY;
}

s32 CARDSetStatusAsync(s32 chan, s32 fileNo, CARDStat *stat, CARDCallback cb)
{
    s32 r = CARDSetStatus(chan, fileNo, stat);
    if (cb) {
        cb(chan, r);
    }
    return r;
}

s32 CARDGetAttributes(s32 chan, s32 fileNo, u8 *attr)
{
    const unsigned char *ent;

    if (fileNo < 0 || fileNo >= GCC_MAXFILE) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    ent = DIRENT(gcc_dircur, fileNo);
    if (ent[E_GAME] == 0xff) {
        return CARD_RESULT_NOFILE;
    }
    if (attr) {
        *attr = ent[E_PERM];
    }
    return CARD_RESULT_READY;
}

s32 CARDSetAttributes(s32 chan, s32 fileNo, u8 attr)
{
    unsigned char *ent;

    if (fileNo < 0 || fileNo >= GCC_MAXFILE) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    ent = DIRENT(gcc_dircur, fileNo);
    if (ent[E_GAME] == 0xff) {
        return CARD_RESULT_NOFILE;
    }
    ent[E_PERM] = attr;
    gcc_dir_commit();
    return CARD_RESULT_READY;
}

s32 CARDSetAttributesAsync(s32 chan, s32 fileNo, u8 attr, CARDCallback cb)
{
    s32 r = CARDSetAttributes(chan, fileNo, attr);
    if (cb) {
        cb(chan, r);
    }
    return r;
}

s32 CARDRename(s32 chan, const char *oldName, const char *newName)
{
    int no;
    unsigned char *ent;
    unsigned n;

    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (!gcc_ready) {
        return CARD_RESULT_BROKEN;
    }
    if (!oldName || !newName) {
        return CARD_RESULT_FATAL_ERROR;
    }
    if (gcc_len(newName) > (unsigned)CARD_FILENAME_MAX) {
        return CARD_RESULT_NAMETOOLONG;
    }
    if (gcc_find(newName) >= 0) {
        return CARD_RESULT_EXIST;
    }
    no = gcc_find(oldName);
    if (no < 0) {
        return CARD_RESULT_NOFILE;
    }
    ent = DIRENT(gcc_dircur, no);
    memset(ent + E_NAME, 0, CARD_FILENAME_MAX);
    n = gcc_len(newName);
    if (n > (unsigned)CARD_FILENAME_MAX) {
        n = (unsigned)CARD_FILENAME_MAX;
    }
    memcpy(ent + E_NAME, newName, n);
    gcc_dir_commit();
    return CARD_RESULT_READY;
}

s32 CARDRenameAsync(s32 chan, const char *oldName, const char *newName, CARDCallback cb)
{
    s32 r = CARDRename(chan, oldName, newName);
    if (cb) {
        cb(chan, r);
    }
    return r;
}

s32 CARDGetResultCode(s32 chan)
{
    if (chan < 0 || chan >= 2) {
        return CARD_RESULT_FATAL_ERROR;
    }
    return gcc_present(chan) ? CARD_RESULT_READY : CARD_RESULT_NOCARD;
}

s32 CARDGetXferredBytes(s32 chan)
{
    (void)chan;
    return 0;
}

s32 CARDGetCurrentMode(s32 chan, u32 *mode)
{
    if (!gcc_present(chan)) {
        return CARD_RESULT_NOCARD;
    }
    if (mode) {
        *mode = 0;
    }
    return CARD_RESULT_READY;
}

BOOL CARDGetFastMode(void)
{
    return FALSE;
}

BOOL CARDSetFastMode(BOOL enable)
{
    (void)enable;
    return FALSE;
}

/* ================================================================= host surface */
/* Exported to JS through build_wasm.sh's EXPORTED_FUNCTIONS (emscripten prefixes an
 * underscore: ___recomp_card_base etc.). WITHOUT those entries Binaryen -O2 proves gcc_img
 * is module-private and dead-strips it -- the same trap the gx_fifo_base comment at
 * build_wasm.sh:651-654 warns about.
 *
 * Protocol: the host writes a persisted 2 MiB image into [base, base+size) BEFORE
 * Module._main() (CARDInit runs inside main and adopts it), then polls _seq() -- any
 * mutation bumps it -- and snapshots the buffer back out once the counter goes quiet.
 * _adopt() re-validates after a live image swap; _slots() picks which slots report a card;
 * _time() supplies the wall clock used for dir-entry timestamps. */
unsigned __recomp_card_base(void)
{
    return (unsigned)gcc_img;
}

unsigned __recomp_card_size(void)
{
    return (unsigned)GCC_IMG_SIZE;
}

unsigned __recomp_card_seq(void)
{
    return gcc_seq;
}

void __recomp_card_slots(int mask)
{
    gcc_slots = mask & 3;
}

/* seconds since 2000-01-01 00:00:00, the CARDDir.time epoch (dolsdk2001 card.h:35) */
void __recomp_card_time(unsigned secs)
{
    gcc_clock = (u32)secs;
}
