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

// -------- display-list capture (2026-08-24) --------
// The game BUILDS its 3D-model geometry at load time via GXBeginDisplayList ->
// GXPosition1x16/... -> GXEndDisplayList (hsfdraw.c MakeDL: dlSize = GXEndDisplayList()).
// The SDK's mechanism (swap the CPU-fifo object, count from PI regs) is invisible to this
// software pipe, so every model DL captured 0 bytes and GXCallDisplayList emitted size=0 —
// NO 3D geometry ever reached the stream. Redirect: while a DL is open, wgpipe bytes land
// in the game's own DL buffer (guest memory); end pads to 32B with GX NOPs (0x00), matching
// real write-gather-pipe burst padding and GXCallDisplayList's 32B-alignment invariant.
static u8 *gx_dl_buf = 0;
static u32 gx_dl_head = 0, gx_dl_cap = 0;
void gx_wgpipe_dl_begin(void *buf, u32 cap) { gx_dl_buf = (u8 *)buf; gx_dl_head = 0; gx_dl_cap = cap; }
u32 gx_wgpipe_dl_end(void) {
    u32 n = gx_dl_head;
    while ((n & 31u) && n < gx_dl_cap) gx_dl_buf[n++] = 0;   /* GX NOP pad to 32B */
    gx_dl_buf = 0; gx_dl_head = 0; gx_dl_cap = 0;
    return n;
}

void gx_wgpipe_u8(u8 v) {
    if (gx_dl_buf) { if (gx_dl_head < gx_dl_cap) gx_dl_buf[gx_dl_head++] = v; return; }
    if (gx_fifo_head < GX_FIFO_SIZE) gx_fifo_buf[gx_fifo_head++] = v;
}
void gx_wgpipe_u16(u16 v) { gx_wgpipe_u8((u8)(v >> 8));  gx_wgpipe_u8((u8)v); }
void gx_wgpipe_u32(u32 v) { gx_wgpipe_u16((u16)(v >> 16)); gx_wgpipe_u16((u16)v); }
void gx_wgpipe_u64(u64 v) { gx_wgpipe_u32((u32)(v >> 32)); gx_wgpipe_u32((u32)v); }
void gx_wgpipe_f32(f32 v) { union { f32 f; u32 u; } c; c.f = v; gx_wgpipe_u32(c.u); }
void gx_wgpipe_f64(f64 v) { union { f64 f; u64 u; } c; c.f = v; gx_wgpipe_u64(c.u); }
