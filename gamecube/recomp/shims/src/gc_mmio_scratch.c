// [wasm-recomp 2026-08-21] GX register-MMIO redirect for the decomp->wasm native port.
//
// On real hardware GXInit (GXInit.c:81-84) points __cpReg/__piReg/__peReg/__memReg at the
// uncached MMIO window (OSPhysicalToUncached(0xC00xxxx) = 0xCC00xxxx). Under the wasm
// identity map that address is past the linear-memory ceiling (2176 MB = 0x88000000), so the
// first register store (GXSetCPUFifo) faults with "memory access out of bounds".
//
// The recomp does NOT need real GX registers: the GP-FIFO command stream (software
// write-gather-pipe in gx_wgpipe.c -> recomp_render_fifo -> Dolphin's OpcodeDecoder) is what
// actually renders. Those direct register writes are hardware-init that Dolphin performs
// itself when it consumes the FIFO; here they only need a valid in-range target so they do
// not fault. __recomp_reg_base maps each register block's physical base into one scratch
// page (CP@+0, PE@+0x1000, PI@+0x3000, MEM@+0x4000 — all distinct, no aliasing). Reads of
// these registers return whatever was last written (0 at boot), which is fine: GXInit /
// InitGX / GXCopyDisp are fire-and-forget with no hardware spin-waits (verified in
// gamecube/recomp/BOOT_SCOPE.md §2d).
static unsigned char __recomp_mmio_scratch[0x10000];

void *__recomp_reg_base(unsigned paddr) {
  return &__recomp_mmio_scratch[paddr & 0xFFFF];
}
