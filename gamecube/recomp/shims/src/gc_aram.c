// Emulated ARAM (Auxiliary/audio RAM) for the decomp->wasm recomp.
//
// Real GameCube ARAM DMA is programmed through the DSP MMIO block __DSPRegs (= (vu16*)0xCC005000),
// which is far above every reachable wasm-memory bound -> ARStartDMA's register writes trap
// out-of-bounds (the frame-41 OOB reached via BootExec -> HuAR_DVDtoARAM -> ARQ -> ARStartDMA).
//
// ARAM is used by the game as a staging store: HuAR_DVDtoARAM copies DVD data MRAM->ARAM, and
// later HuAR_ARAMtoMRAM copies it back ARAM->MRAM. So the transfer must actually MOVE bytes, not
// just be neutralized. Model ARAM as a flat 16MB buffer (matches the neutralized __AR_Size in
// build_wasm.sh) and do the DMA as a memcpy. ARStartDMA is baked to call __recomp_ar_dma; the ARQ
// queue's completion (callbacks) is driven synchronously from HuARDMACheck (see build_wasm.sh).
//
// Guest main memory is flat here: a cached pointer 0x80xxxxxx equals its wasm linear-memory offset
// (same convention the harness uses to stage BootInfo/FST), so mainmem_addr is a direct pointer.

#include <stdint.h>
#include <string.h>

#define RECOMP_ARAM_SIZE 0x1000000u   /* 16 MB */
static unsigned char __recomp_aram[RECOMP_ARAM_SIZE];

// __ARQPopTaskQueueHi / __ARQServiceQueueLo already order the args so arg1 is ALWAYS the main-mem
// address and arg2 the ARAM address, regardless of direction (they swap source/dest for reads).
//   type 0 = ARAM_DIR_MRAM_TO_ARAM (write to ARAM)
//   type 1 = ARAM_DIR_ARAM_TO_MRAM (read from ARAM)
extern void __recomp_dirty_note(void *addr, unsigned nBytes);   /* gc_dirty_ring.c */

void __recomp_ar_dma(unsigned type, unsigned mainmem_addr, unsigned aram_addr, unsigned length) {
    if (!length) return;
    if (aram_addr >= RECOMP_ARAM_SIZE || length > RECOMP_ARAM_SIZE ||
        aram_addr + length > RECOMP_ARAM_SIZE) return;         /* ARAM-side bounds guard */
    unsigned char *mram = (unsigned char *)(uintptr_t)mainmem_addr;
    if (type == 0) memcpy(__recomp_aram + aram_addr, mram, length);   /* MRAM -> ARAM */
    else {
        memcpy(mram, __recomp_aram + aram_addr, length);   /* ARAM -> MRAM */
        /* ARAM->MRAM restage rewrites main RAM with NO DVD read and NO DCStoreRange —
         * invisible to both cacheDirty and the flush ring. The render bridge's
         * address-keyed caches (walked DLs, synced arrays, textures) go stale and
         * poison every scene reached through an ARAM restage (found 2026-08-26: the
         * live world rendered garbage triangles that a full-mem1-per-frame test
         * cleared). Note the range so the bridge re-syncs + invalidates. */
        __recomp_dirty_note(mram, length);
    }
}
