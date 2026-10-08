/* urdirty.h — WRITE TRACKING FOR THE ROLLBACK RING (2026-10-08)
 *
 * The worker's rollback ring (dist/wasmpsx_worker.js, THE ROLLBACK RING IS AN
 * UNDO LOG) saves a frame by finding the 4 KB pages of [1024, sbrk) that
 * changed since the last save. It used to find them by comparing all ~6.9 MB
 * against its shadow copy every frame: ~1.2 ms of a ~5 ms room step (20% of the
 * worker's CPU, measured in a Monster Rancher 2 room profile).
 *
 * Most of that range is a few big guest memories that are written through a
 * handful of code paths: main RAM, the BIOS image, the memory LUTs, VRAM, SPU
 * RAM and the memory-card images. Those are TRACKED SPANS: every C write path
 * into them marks the pages it writes in ur_dirty[] (one byte per 4 KB page of
 * wasm memory), and the save compares only the marked pages of a tracked span
 * (a marked page that did not really change is found equal and not logged).
 * Everything that is NOT in a tracked span is still compared in full, every
 * save, exactly as before.
 *
 * Exactness rests on one rule: a write into a tracked span that does not mark
 * its page would be missed. So every writer marks, and anything that writes a
 * tracked span wholesale (reset, BIOS load, savestate load, plugin init)
 * marks it all. The worker's ?urcheck=1 runs the full compare beside the
 * tracked one on every save and counts pages the full one found that the
 * tracked one did not (urcheck.miss); the probes require 0. A span can be
 * dropped back to full comparison at run time (ur_track_off), which the HLE
 * BIOS does: its routines write RAM through raw pointers everywhere.
 *
 * The page table and the span table live in one malloc'd block outside every
 * span, which the worker never compares, logs, hashes or restores. */
#ifndef __URDIRTY_H__
#define __URDIRTY_H__

#include <stddef.h>
#include <stdint.h>

#define UR_PAGE_SHIFT 12
#define UR_PAGES 65536          /* 256 MB of wasm memory (MAXIMUM_MEMORY) / 4 KB */
#define UR_MAX_SPANS 16

/* ur_info layout (u32 words), read by the worker:
 *   [0] the page table's address   [1] the number of spans   [2] the block's byte size
 *   [3] the clear generation: the worker adds 1 every time it clears the table
 *       (a writer that marks the same range over and over may skip a range it
 *       already marked in the same generation — ur_gen())
 *   [4 + 3i] span i lo  [5 + 3i] span i hi (bytes, absolute)  [6 + 3i] span i on (0/1) */
extern unsigned char *ur_dirty;
extern volatile uint32_t *ur_genp;
#define ur_gen() (*ur_genp)
/* Host-only words for a writer's own bookkeeping (the drawing-area cache in
 * dfxvideo/gpu.c). ⚠ NEVER keep such state in a C static: static data is in
 * the rollback snapshot AND the fingerprint, and a value that depends on how
 * often THIS console saved (the generation does) makes two consoles that agree
 * on every guest byte fingerprint differently — measured: the rollback probe
 * mismatched 15 of 59 checkpoints on Monster Rancher 2 when this cache was a
 * static. These words live in the table's block: never compared, logged,
 * hashed or restored. */
extern uint32_t *ur_scratch;   /* UR_SCRATCH_WORDS words */
#define UR_SCRATCH_WORDS 16

#define UR_MARK(p) (ur_dirty[(uintptr_t)(p) >> UR_PAGE_SHIFT] = 1)
void ur_mark_range(const void *p, size_t n);
/* id: a small constant naming the span (UR_SPAN_*); re-registering replaces it */
void ur_track(int id, const void *p, size_t n);
void ur_track_off(int id);
void ur_mark_span(int id);
void ur_mark_all(void);

enum { UR_SPAN_RAM, UR_SPAN_BIOS, UR_SPAN_RLUT, UR_SPAN_WLUT, UR_SPAN_VRAM, UR_SPAN_SPU, UR_SPAN_MCD1, UR_SPAN_MCD2, UR_SPAN_PAR };

#endif
