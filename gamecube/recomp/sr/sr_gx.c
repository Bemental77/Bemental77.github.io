// sr_gx.c — THE WRITE-GATHER PIPE, CAPTURED AS A FIFO STREAM.
//
// [sr-gx 2026-09-04]  The one thing this image needed to be able to put a picture on a
// screen, and the reason it is small: the picture is not something this file draws.
//
// ------------------------------------------------------------------ WHAT THIS IS FOR
// gamecube/recomp/ (the Mario Party 4 path) reaches a screen by REPLACING the decomp's
// write-gather pipe at the C level: shims/dolphin/gx/GXVert.h:40 redefines `GXWGFifo`
// to a staging slot and every GX_WRITE_* macro to a call into shims/src/gx_wgpipe.c,
// which appends big-endian into a 4 MB buffer.  recomp_worker.js:1056 then posts that
// buffer to the page, worker_funcs.js:953 hands it to Module._recomp_render_fifo, and
// EmscriptenWorker.cpp:565 runs it through Dolphin's own OpcodeDecoder::RunFifo.
//
// THAT CONSUMER IS ENGINE-AGNOSTIC.  It takes a big-endian GP-FIFO opcode stream and a
// MEM1 image; it does not care which producer built them.  So this image does not need
// a renderer, and must not grow one -- it needs to hand the SAME consumer the SAME two
// things.  MEM1 it already has (sr_driver.c:38 allocates the real 24 MB and every
// translated store writes big-endian into it, so it is byte-identical to what Dolphin
// wants, with none of the LE->BE swapping recomp_worker.js:410-427 has to do).  The
// FIFO stream is what was missing, and this file is it.
//
// --------------------------------------------------------------- WHY IT WAS MISSING
// This image translates SAB's OWN GX library out of main.dol -- 90 GX bodies are
// emitted (`grep -c "/\* GX" sr_dispatch.c`), GXDrawDone is fn_8010154c.  Nothing is
// shimmed.  So a GX command here is a plain guest store to 0xCC008000, gekko_rt.h:199
// maps it into a 4 KB scratch page, and before this file NOTHING READ THAT PAGE.  Every
// 4 KB of pushed state overwrote itself.
//
// That is worth stating precisely, because it is a gap in the INSTRUMENT and not only
// in the output: with WPAR unhooked, "the boot never reached GX" and "GX ran and its
// entire output was discarded" produce identical evidence -- no dev_log entry, no
// counter, nothing.  sr_gx_writes()/sr_gx_bytes() below close that hole, and they count
// whether or not the capture is armed, so the question can be answered separately from
// whether anyone kept the bytes.
//
// ------------------------------------------------------------------- THE CONTROL ARM
// g_gx_capture defaults OFF and is switched at RUN TIME (sr_gx_set_capture), never at
// link time.  This is the discipline sr_image.c's set_exi_model / set_dsp_model and
// sr_host_os.c's sr_os_mode already establish here: an arm that a rebuild stands
// between is not a control arm, because the two readings come from two binaries with
// two md5s.  Capture OFF is the falsifying arm for every claim made about these bytes
// -- it must produce zero FIFO bytes and therefore no frame, on the same wasm.
#include <stdint.h>
#include <string.h>
#include <emscripten.h>
#include "gekko_rt.h"

#ifdef SR_MMIO

// 8 MB.  Sized against the producer it is replacing (gx_wgpipe.c:11 uses 4 MB per
// frame for MP4) with headroom, because unlike that one this buffer is CUMULATIVE by
// default: see sr_gx_fifo_reset() below.  It is static rather than malloc'd so the
// address is stable for the whole run and JS can hold the base across calls.
#define SR_GX_FIFO_CAP (8u << 20)

static uint8_t  g_gx_fifo[SR_GX_FIFO_CAP];
static uint32_t g_gx_pos     = 0;   // bytes captured
static uint32_t g_gx_dropped = 0;   // bytes refused after the buffer filled
static uint32_t g_gx_writes  = 0;   // WPAR store EVENTS      -- counted with capture off
static uint32_t g_gx_bytes   = 0;   // WPAR store BYTES       -- counted with capture off
static uint32_t g_gx_off_max = 0;   // largest offset seen INTO the WPAR page (see below)
static int      g_gx_capture = 0;   // THE ARM.  Off by default.

// THE HOOK.  gekko_rt.h:GK_WPOST sends everything at or above GK_WPAR_OFF here, so this
// function owns the split and gk_dev_write keeps exactly the domain it had.
void gk_tail_write(uint32_t p, uint32_t n) {
    if (p >= GK_HWREG_OFF) { gk_dev_write(p, n); return; }

    // ---- WPAR.  p is a physical offset inside the 4 KB page at GK_WPAR_OFF.
    //
    // WHY APPENDING g_ram[p..p+n) IS THE STREAM AND NOT AN APPROXIMATION OF IT.  The
    // store has ALREADY landed (GK_WPOST fires after the bytes are written,
    // gekko_rt.h:328-333), and gk_w8/16/32 write BIG-ENDIAN.  gk_w64 is two gk_w32 in
    // order and gk_psq_st (gekko_rt.h:485) is two gk_w32 in order, so a 64-bit push
    // arrives here as two ordered 4-byte appends, not one reversed 8.  Concatenating in
    // call order therefore reproduces the byte sequence the gather buffer would have
    // DMA'd into the CP FIFO -- which is exactly what OpcodeDecoder::RunFifo consumes.
    //
    // The one assumption is that the guest pushes at offset 0 of the page, which is
    // what GX does (the whole GXWGFifo union sits at 0xCC008000 and every member is at
    // offset 0).  It is an ASSUMPTION, so it is MEASURED rather than trusted:
    // g_gx_off_max is reported alongside the stream, and a nonzero value means the
    // concatenation order above is wrong and the stream must not be believed.
    const uint32_t off = p - GK_WPAR_OFF;
    if (off > g_gx_off_max) g_gx_off_max = off;

    g_gx_writes++;
    g_gx_bytes += n;
    if (!g_gx_capture) return;
    if (g_gx_pos + n > SR_GX_FIFO_CAP) { g_gx_dropped += n; return; }
    memcpy(g_gx_fifo + g_gx_pos, g_ram + p, n);
    g_gx_pos += n;
}

// ---- THE ARM
EMSCRIPTEN_KEEPALIVE void sr_gx_set_capture(int on) { g_gx_capture = on ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int  sr_gx_get_capture(void)   { return g_gx_capture; }

// ---- THE STREAM.  base is a byte offset into the wasm heap; JS reads
// HEAPU8.subarray(base, base + pos).
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_fifo_base(void) { return (uint32_t)(uintptr_t)g_gx_fifo; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_fifo_pos(void)  { return g_gx_pos; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_fifo_cap(void)  { return SR_GX_FIFO_CAP; }

// CUMULATIVE BY DEFAULT, and the caller has to ask for a cut.  gx_wgpipe.c resets per
// frame because MP4's producer prepends a full CP/XF/BP register shadow to every frame
// (recomp_worker.js:1048-1053) so each one is self-contained.  This image has no such
// shadow: its register state exists only as the GX init traffic that flowed through
// here once.  Cutting the stream would therefore throw away the state that makes every
// later frame decodable -- so the default is to keep it, and a caller that has arranged
// its own prologue can cut explicitly.
EMSCRIPTEN_KEEPALIVE void sr_gx_fifo_reset(void) { g_gx_pos = 0; g_gx_dropped = 0; }

// ---- THE WITNESSES.  These count with the capture OFF, which is what makes "did GX
// execute?" answerable independently of "did anyone keep the bytes?".
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_writes(void)  { return g_gx_writes; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_bytes(void)   { return g_gx_bytes; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_dropped(void) { return g_gx_dropped; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_off_max(void) { return g_gx_off_max; }

#endif /* SR_MMIO */
