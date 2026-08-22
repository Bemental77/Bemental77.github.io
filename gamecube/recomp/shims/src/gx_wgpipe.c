// [wasm-recomp 2026-08-21] Software write-gather-pipe backing store.
// Reproduces the GameCube GP-FIFO byte stream the game emits (via the GXVert.h shim)
// into a real, host-readable ring buffer, so (a) the writes are in-bounds and
// observable — Binaryen -O2 no longer dead-strips them — and (b) the host can hand the
// stream to the existing WGPU OpcodeDecoder. The GP-FIFO is big-endian (Gekko); wasm is
// little-endian, so each value is appended most-significant-byte first, matching the
// exact byte order a real Gekko CPU would burst through the write-gather pipe.
#include <dolphin/types.h>
#include <dolphin/gx/GXVert.h>

#define GX_FIFO_SIZE (4 * 1024 * 1024)
static u8  gx_fifo_buf[GX_FIFO_SIZE];
static u32 gx_fifo_head = 0;

// Staging cell for any direct `GXWGFifo.member = x` use in compiled units (the hot
// immediate-mode writers go through the gx_wgpipe_* appenders below, not this cell).
PPCWGPipe gx_wgpipe_slot;

// Host-facing accessors (exported from the module; the renderer reads [base, base+pos)).
u8  *gx_fifo_base(void)  { return gx_fifo_buf; }
u32  gx_fifo_pos(void)   { return gx_fifo_head; }
void gx_fifo_reset(void) { gx_fifo_head = 0; }

void gx_wgpipe_u8(u8 v)   { if (gx_fifo_head < GX_FIFO_SIZE) gx_fifo_buf[gx_fifo_head++] = v; }
void gx_wgpipe_u16(u16 v) { gx_wgpipe_u8((u8)(v >> 8));  gx_wgpipe_u8((u8)v); }
void gx_wgpipe_u32(u32 v) { gx_wgpipe_u16((u16)(v >> 16)); gx_wgpipe_u16((u16)v); }
void gx_wgpipe_u64(u64 v) { gx_wgpipe_u32((u32)(v >> 32)); gx_wgpipe_u32((u32)v); }
void gx_wgpipe_f32(f32 v) { union { f32 f; u32 u; } c; c.f = v; gx_wgpipe_u32(c.u); }
void gx_wgpipe_f64(f64 v) { union { f64 f; u64 u; } c; c.f = v; gx_wgpipe_u64(c.u); }
