#ifndef _DOLPHIN_GXVERT
#define _DOLPHIN_GXVERT
// [wasm-recomp 2026-08-21] SOFTWARE WRITE-GATHER-PIPE.
// On GameCube the CPU streams the GP-FIFO by storing to the MMIO write-gather-pipe at
// 0xCC008000 (GXFIFO_ADDR); each store auto-advances the FIFO. In wasm that address is
// out of linear-memory bounds, and Binaryen -O2 dead-strips the (unobservable) volatile
// stores — so the compiled game emits NOTHING the renderer can consume. This shim keeps
// the game's exact immediate-mode call sequence but redirects every pipe write into a
// real, host-readable ring buffer (gx_wgpipe_* in shims/src/gx_wgpipe.c), reproducing
// the big-endian GP-FIFO byte stream that the existing WGPU OpcodeDecoder already knows
// how to draw. Overrides the decomp's include/dolphin/gx/GXVert.h.
#include <dolphin/types.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GXFIFO_ADDR 0xCC008000

typedef union {
  u8 u8; u16 u16; u32 u32; u64 u64;
  s8 s8; s16 s16; s32 s32; s64 s64;
  f32 f32; f64 f64;
} PPCWGPipe;

// The host write-gather-pipe appenders (defined in shims/src/gx_wgpipe.c). Each appends
// the value big-endian to the FIFO ring and advances the cursor, exactly like the
// hardware WGPipe burst. gx_fifo_base()/gx_fifo_pos()/gx_fifo_reset() expose the ring.
void gx_wgpipe_u8(u8 v);
void gx_wgpipe_u16(u16 v);
void gx_wgpipe_u32(u32 v);
void gx_wgpipe_u64(u64 v);
void gx_wgpipe_f32(f32 v);
void gx_wgpipe_f64(f64 v);

// A few decomp units (excluded asm ones aside) take &GXWGFifo.f32 or assign GXWGFifo.*
// directly. Route the fixed-address union to a 1-slot staging cell whose writes are
// flushed by the accessor macros below, so direct `GXWGFifo.u16 = x` still appends.
extern PPCWGPipe gx_wgpipe_slot;
#define GXWGFifo gx_wgpipe_slot

static inline void GXPosition2f32(const f32 x, const f32 y) { gx_wgpipe_f32(x); gx_wgpipe_f32(y); }
static inline void GXPosition2u16(const u16 x, const u16 y) { gx_wgpipe_u16(x); gx_wgpipe_u16(y); }
static inline void GXPosition2s16(const s16 x, const s16 y) { gx_wgpipe_u16((u16)x); gx_wgpipe_u16((u16)y); }
static inline void GXPosition3s16(const s16 x, const s16 y, const s16 z) { gx_wgpipe_u16((u16)x); gx_wgpipe_u16((u16)y); gx_wgpipe_u16((u16)z); }
static inline void GXPosition3u8(const u8 x, const u8 y, const u8 z) { gx_wgpipe_u8(x); gx_wgpipe_u8(y); gx_wgpipe_u8(z); }
static inline void GXPosition3f32(const f32 x, const f32 y, const f32 z) { gx_wgpipe_f32(x); gx_wgpipe_f32(y); gx_wgpipe_f32(z); }
static inline void GXNormal3s16(const s16 x, const s16 y, const s16 z) { gx_wgpipe_u16((u16)x); gx_wgpipe_u16((u16)y); gx_wgpipe_u16((u16)z); }
static inline void GXNormal3f32(const f32 x, const f32 y, const f32 z) { gx_wgpipe_f32(x); gx_wgpipe_f32(y); gx_wgpipe_f32(z); }
static inline void GXColor1u32(const u32 v) { gx_wgpipe_u32(v); }
static inline void GXColor3u8(const u8 r, const u8 g, const u8 b) { gx_wgpipe_u8(r); gx_wgpipe_u8(g); gx_wgpipe_u8(b); }
static inline void GXColor4u8(const u8 r, const u8 g, const u8 b, const u8 a) { gx_wgpipe_u8(r); gx_wgpipe_u8(g); gx_wgpipe_u8(b); gx_wgpipe_u8(a); }
static inline void GXTexCoord2s16(const s16 u, const s16 v) { gx_wgpipe_u16((u16)u); gx_wgpipe_u16((u16)v); }
static inline void GXTexCoord2f32(const f32 u, const f32 v) { gx_wgpipe_f32(u); gx_wgpipe_f32(v); }
static inline void GXPosition1x8(u8 index) { gx_wgpipe_u8(index); }
static inline void GXColor1x8(u8 index) { gx_wgpipe_u8(index); }
static inline void GXPosition1x16(u16 index) { gx_wgpipe_u16(index); }
static inline void GXNormal1x16(u16 index) { gx_wgpipe_u16(index); }
static inline void GXColor1x16(u16 index) { gx_wgpipe_u16(index); }
static inline void GXTexCoord1x16(u16 index) { gx_wgpipe_u16(index); }
static inline void GXUnknownu16(const u16 x) { gx_wgpipe_u16(x); }
static inline void GXEnd(void) {}

#ifdef __cplusplus
}
#endif

#endif // _DOLPHIN_GXVERT
