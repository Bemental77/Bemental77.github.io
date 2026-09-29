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

// ------------------------------------------------------------ THE GP COMMAND DECODER
// [2026-09-29] The stream is also DECODED here, command by command, with the capture arm
// off or on, so the pixel engine's side effects that the CPU waits on (GXSetDrawDone ->
// PE FINISH, GXSetDrawSync -> PE TOKEN) can be raised by sr_image.c's PE model, and a frame
// can be cut at its copy to the XFB.  Transcribed from Dolphin's own decoder:
//   command sizes         VideoCommon/OpcodeDecoding.h:130-245 (detail::RunCommand)
//   CP VCD / VAT state    VideoCommon/CPMemory.cpp:132-182 (LoadCPReg), bitfields CPMemory.h
//   vertex size           VideoCommon/VertexLoaderBase.cpp:274-302 and the four
//                         VertexLoader_{Position,Normal,Color,TextCoord}.h size tables
// Display lists (0x40) are opaque 9-byte commands here: their CONTENTS are not decoded, so a
// BP write inside a display list is not seen (counted in g_gp_dls).  An opcode Dolphin would
// hand to OnUnknown is REPORTED (sr_gp_on_unknown), never skipped silently.
void sr_gp_on_bp(uint32_t reg, uint32_t val);          // sr_image.c
void sr_gp_on_unknown(uint32_t op);                     // sr_image.c
static uint32_t g_vcd_lo = 0, g_vcd_hi = 0, g_vat[8][3];
static uint8_t  g_hdr[80];
static uint32_t g_hn = 0, g_skip = 0;
static uint32_t g_gp_cmds = 0, g_gp_prims = 0, g_gp_verts = 0, g_gp_dls = 0, g_gp_unknown = 0,
                g_gp_bad_fmt = 0;
static uint32_t cf_bytes(uint32_t f) { return f <= 1 ? 1u : f <= 3 ? 2u : 4u; }   // u8 s8 | u16 s16 | f32 (5-7 as f32)
static uint32_t vtx_size(uint32_t vat) {
    const uint32_t lo = g_vcd_lo, hi = g_vcd_hi, g0 = g_vat[vat][0], g1 = g_vat[vat][1], g2 = g_vat[vat][2];
    uint32_t size = (uint32_t)__builtin_popcount(lo & 0x1FFu);            // PosMatIdx + TexMatIdx
    uint32_t t = (lo >> 9) & 3u;                                          // Position
    if (t == 1) size += cf_bytes((g0 >> 1) & 7u) * ((g0 & 1u) ? 3u : 2u);
    else if (t) size += t - 1u;                                           // index8 = 1, index16 = 2
    t = (lo >> 11) & 3u;                                                  // Normal
    if (t) {
        uint32_t ntb = (g0 >> 9) & 1u, idx3 = (g0 >> 31) & 1u;
        if (t == 1) size += cf_bytes((g0 >> 10) & 7u) * (ntb ? 9u : 3u);
        else        size += (t - 1u) * ((ntb && idx3) ? 3u : 1u);
    }
    for (uint32_t c = 0; c < 2; c++) {                                    // Color0/1
        t = (lo >> (13 + 2 * c)) & 3u;
        uint32_t fmt = (g0 >> (c ? 18 : 14)) & 7u;
        if (t == 1) { static const uint8_t cs[6] = {2, 3, 4, 2, 3, 4};
                      if (fmt > 5) { g_gp_bad_fmt++; } else size += cs[fmt]; }
        else if (t) size += t - 1u;
    }
    static const uint8_t cnt_bit[8] = {21, 0, 9, 18, 27, 5, 14, 23};      // TexNCoordElements
    static const uint8_t fmt_bit[8] = {22, 1, 10, 19, 28, 6, 15, 24};     // TexNCoordFormat
    static const uint8_t grp[8]     = {0, 1, 1, 1, 1, 2, 2, 2};
    for (uint32_t i = 0; i < 8; i++) {                                    // Tex0..7
        t = (hi >> (2 * i)) & 3u;
        if (!t) continue;
        const uint32_t g = grp[i] == 0 ? g0 : grp[i] == 1 ? g1 : g2;
        if (t == 1) size += cf_bytes((g >> fmt_bit[i]) & 7u) * (((g >> cnt_bit[i]) & 1u) ? 2u : 1u);
        else size += t - 1u;
    }
    return size;
}
static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static void gp_feed(const uint8_t *b, uint32_t n) {
    while (n) {
        if (g_skip) { uint32_t k = n < g_skip ? n : g_skip; g_skip -= k; b += k; n -= k; continue; }
        g_hdr[g_hn++] = *b++; n--;
        const uint8_t op = g_hdr[0];
        uint32_t need;
        if (op == 0x00) { g_hn = 0; continue; }                            // NOP
        else if (op == 0x08) need = 6;                                     // CP
        else if (op == 0x10) need = g_hn < 5 ? 5 : 5 + 4 * (((be32(g_hdr + 1) >> 16) & 0xFu) + 1);  // XF
        else if (op == 0x20 || op == 0x28 || op == 0x30 || op == 0x38) need = 5;   // indexed XF
        else if (op == 0x40) need = 9;                                     // CALL_DL
        else if (op == 0x48) need = 1;                                     // INVL_VC
        else if (op == 0x61) need = 5;                                     // BP
        else if (op >= 0x80 && op <= 0xBF) need = 3;                       // primitive header
        else { g_gp_unknown++; g_hn = 0; sr_gp_on_unknown(op); continue; }   // OnUnknown: 1 byte
        if (g_hn < need) continue;
        g_gp_cmds++;
        if (op == 0x08) {
            const uint32_t sub = g_hdr[1], v = be32(g_hdr + 2);
            switch (sub & 0xF0u) {
            case 0x50: g_vcd_lo = v; break;
            case 0x60: g_vcd_hi = v; break;
            case 0x70: g_vat[sub & 7u][0] = v; break;
            case 0x80: g_vat[sub & 7u][1] = v; break;
            case 0x90: g_vat[sub & 7u][2] = v; break;
            default: break;
            }
        } else if (op == 0x61) {
            sr_gp_on_bp(g_hdr[1], ((uint32_t)g_hdr[2] << 16) | ((uint32_t)g_hdr[3] << 8) | g_hdr[4]);
        } else if (op == 0x40) {
            g_gp_dls++;
        } else if (op >= 0x80) {
            const uint32_t cnt = ((uint32_t)g_hdr[1] << 8) | g_hdr[2];
            g_gp_prims++; g_gp_verts += cnt;
            g_skip = cnt * vtx_size(op & 7u);
        }
        g_hn = 0;
    }
}
EMSCRIPTEN_KEEPALIVE uint32_t sr_gp_cmds(void)    { return g_gp_cmds; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gp_prims(void)   { return g_gp_prims; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gp_verts(void)   { return g_gp_verts; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gp_dls(void)     { return g_gp_dls; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gp_unknown(void) { return g_gp_unknown; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gp_bad_fmt(void) { return g_gp_bad_fmt; }

// FRAME CUTS in the captured stream: the capture offset just past each copy to the XFB (BP
// 0x52 with bit 14), so a consumer can hand Dolphin one frame at a time.
#define SR_GX_CUTS 4096
static uint32_t g_gx_cuts[SR_GX_CUTS], g_gx_ncuts = 0;
// THE FRAME RING — capture arm 2.  The browser boot runs the guest on pthreads while the
// worker's JS thread streams frames out of the SHARED wasm memory, so the stream is written
// to a byte ring (monotonic write count g_ring_w) and published a WHOLE FRAME at a time:
// g_ring_pub is advanced, with a release store, only at a copy to the XFB.  The reader keeps
// its own read count; if it ever falls more than the ring's size behind, bytes were lost and
// it must say so (sr_render_worker.js reports `lost`), never render a torn stream.
#define SR_GX_RING (8u << 20)
static uint8_t  g_gx_ring[SR_GX_RING];
static uint32_t g_ring_w = 0, g_ring_pub = 0, g_ring_frames = 0;
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_ring_base(void)  { return (uint32_t)(uintptr_t)g_gx_ring; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_ring_cap(void)   { return SR_GX_RING; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_ring_pub(void)   { return __atomic_load_n(&g_ring_pub, __ATOMIC_ACQUIRE); }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_ring_frames(void){ return __atomic_load_n(&g_ring_frames, __ATOMIC_ACQUIRE); }
void sr_gx_mark_frame(void) {
    if (g_gx_ncuts < SR_GX_CUTS) g_gx_cuts[g_gx_ncuts] = g_gx_pos;
    g_gx_ncuts++;
    if (g_gx_capture == 2) {
        __atomic_store_n(&g_ring_pub, g_ring_w, __ATOMIC_RELEASE);
        __atomic_store_n(&g_ring_frames, g_ring_frames + 1, __ATOMIC_RELEASE);
    }
}
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_cuts(void)   { return (uint32_t)(uintptr_t)g_gx_cuts; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_gx_ncuts(void)  { return g_gx_ncuts; }

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
    if (g_gx_capture == 2) {
        for (uint32_t i = 0; i < n; i++) g_gx_ring[(g_ring_w + i) & (SR_GX_RING - 1u)] = g_ram[p + i];
        g_ring_w += n;
    } else if (g_gx_capture) {
        if (g_gx_pos + n > SR_GX_FIFO_CAP) g_gx_dropped += n;
        else { memcpy(g_gx_fifo + g_gx_pos, g_ram + p, n); g_gx_pos += n; }
    }
    gp_feed(g_ram + p, n);      // after the append, so a frame cut lands past its own copy
}

// ---- THE ARM
EMSCRIPTEN_KEEPALIVE void sr_gx_set_capture(int on) { g_gx_capture = on == 2 ? 2 : on ? 1 : 0; }   // 2 = frame ring
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
