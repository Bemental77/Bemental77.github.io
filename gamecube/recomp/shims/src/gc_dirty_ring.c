// [wasm-recomp 2026-08-25] Dirty-range ring for the RAM->Dolphin render bridge.
// On real hardware every CPU write of GPU-visible data is followed by DCStoreRange /
// DCFlushRange (that is what makes it visible to the GPU); in the recomp those were no-op
// imports. Compile them IN and append {addr,size} to a ring, so the bridge re-syncs exactly
// the ranges the game declared dirty this frame (skinning/cluster vertex writes, dynamic
// glyph textures, minigame CPU-built arrays — census: ~150-300 entries/frame worst case,
// hard bound ~2K; 4096 gives >2x headroom, overflow flags a full resync).
// DCInvalidateRange / DCZeroRange stay imports: GPU->CPU direction, nothing to sync.
// NOTE: plain types only (the decomp's stub <stdint.h> shadows emscripten's).
#define RECOMP_DIRTY_CAP 4096

typedef struct { unsigned addr; unsigned size; } RecompDirtyEnt;

static RecompDirtyEnt __recomp_dirty_ring[RECOMP_DIRTY_CAP];
static unsigned __recomp_dirty_n;
static unsigned __recomp_dirty_ovf;

static void __recomp_dirty_push(void *addr, unsigned nBytes) {
    unsigned a = (unsigned)addr;
    if (nBytes == 0) return;
    if (__recomp_dirty_n >= RECOMP_DIRTY_CAP) { __recomp_dirty_ovf = 1; return; }
    {   /* round to 32B cache lines, exactly like the hardware op */
        RecompDirtyEnt *e = &__recomp_dirty_ring[__recomp_dirty_n++];
        e->addr = a & ~31u;
        e->size = ((a + nBytes + 31u) & ~31u) - e->addr;
    }
}

void DCStoreRange(void *a, unsigned n)       { __recomp_dirty_push(a, n); }
void DCStoreRangeNoSync(void *a, unsigned n) { __recomp_dirty_push(a, n); }
void DCFlushRange(void *a, unsigned n)       { __recomp_dirty_push(a, n); }
void DCFlushRangeNoSync(void *a, unsigned n) { __recomp_dirty_push(a, n); }
/* Non-DC entry for host shims that rewrite main RAM outside the game's flush discipline
 * (gc_aram.c ARAM->MRAM restage). Tagged with bit31 of size: a RESTAGE means the address
 * range now holds a DIFFERENT asset (heap reuse), so the render bridge must invalidate
 * every address-keyed cache entry it overlaps — unlike a DC flush, which is a content
 * update to data whose identity is unchanged. */
void __recomp_dirty_note(void *a, unsigned n) {
    unsigned before = __recomp_dirty_n;
    __recomp_dirty_push(a, n);
    if (__recomp_dirty_n > before)
        __recomp_dirty_ring[__recomp_dirty_n - 1].size |= 0x80000000u;
}

unsigned __recomp_dirty_base(void)     { return (unsigned)&__recomp_dirty_ring[0]; }
unsigned __recomp_dirty_count(void)    { return __recomp_dirty_n; }
unsigned __recomp_dirty_overflow(void) { return __recomp_dirty_ovf; }
void     __recomp_dirty_reset(void)    { __recomp_dirty_n = 0; __recomp_dirty_ovf = 0; }
