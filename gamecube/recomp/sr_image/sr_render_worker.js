// sr_render_worker.js — THE STATICALLY RECOMPILED SAB IMAGE, DRIVEN TO A PICTURE.
//
// [sr-gx 2026-09-04]
//
// ============================================================== WHAT THIS IS, EXACTLY
// sr_image_worker.js answers "how far into SAB's own boot does the translated image
// get?" and produces a boundary trajectory.  It renders nothing, and says so
// (sr_image_boot.html:19-23).  This worker answers a different question — "can the
// translated image's GX output reach a screen?" — and it does NOT answer the boot
// question.  Keeping them as two workers keeps the two claims from contaminating each
// other, which is the whole reason this file is not a flag on that one.
//
// ------------------------------------------------------------- IT HAS NO RENDERER
// And it must not grow one.  gamecube/recomp/ (the Mario Party 4 path) already reaches
// the screen through a consumer that is ENGINE-AGNOSTIC: it takes a big-endian GP-FIFO
// opcode stream plus a MEM1 image and runs them through Dolphin's own
// OpcodeDecoder::RunFifo on the WebGPU backend.  The chain is
//   recomp_worker.js:1056   postMessage({cmd:'frame', n, fifo, mem1, regions})
//   gamecube.html:7745      relay -> dolphin_worker {cmd:'recompFrame', ...}
//   worker_funcs.js:953     Module._recomp_render_fifo(ptr, len)
//   worker_funcs.js:956     Module._recomp_present(xfb, 640, 480)
//   EmscriptenWorker.cpp:565  OpcodeDecoder::RunFifo<false>(...) + VertexManager::Flush()
// This worker posts the SAME {cmd:'frame'} message with the SAME field names, so the
// page relays it and the consumer draws it without knowing which engine produced it.
//
// ---------------------------------------------------- WHY THE SR SIDE IS THE EASY SIDE
// Two things the MP4 producer has to synthesize, this one already has for free:
//
//   MEM1.  sr_driver.c:38 allocates the real 24 MB, and every translated store writes
//   BIG-ENDIAN into it (gekko_rt.h:328-333).  So guest RAM here is byte-identical to
//   what Dolphin wants and needs NONE of the LE->BE vertex-array swapping
//   recomp_worker.js:410-427 has to do, and none of the region bookkeeping either — the
//   whole image is authoritative, so `regions` is always empty on this path.
//
//   THE FIFO.  GX is not shimmed here.  SAB's own GX library is TRANSLATED out of
//   main.dol (90 GX bodies in sr_dispatch.c; GXDrawDone is fn_8010154c), so a GX command
//   is a plain guest store to 0xCC008000 executed by translated guest code.  sr_gx.c
//   captures those stores in order.  Every byte in the stream this worker posts was
//   written by SAB's own code — nothing here hand-builds a FIFO packet.
//
// =============================================================== WHAT IS *NOT* CLAIMED
// ⚠ THIS IS A DRIVEN RENDER, NOT A PACED GUEST.  The image's boot stops in
// __OSInitAudioSystem on a DSP register (README §10) and therefore never reaches its own
// video init.  So the `drive` program below CALLS SAB's GX entry points directly, in the
// order the SDK requires, instead of waiting for the game to call them.  Consequences,
// stated up front because a reader could otherwise take the wrong number away:
//
//   * NO GUEST RATE IS CLAIMED OR CLAIMABLE HERE.  There is no guest main loop, so
//     "1.000x" has no referent on this path.  CLAUDE.md gate #9 is about the guest
//     simulation rate; this worker does not simulate a guest timeline at all, and it
//     publishes no speed field.  Do not read the frame counter as one.
//   * The pixels are the guest's, the SCHEDULE is the host's.  Every FIFO byte comes
//     from translated SAB code; the decision to call GXCopyDisp came from here.
//   * `mode:'main'` is the arm that removes the hand-driving: it calls SAB's own `main`
//     under the watchdog and reports how many WPAR bytes the GAME produced by itself.
//     That is the honest measurement of how close the unaided boot is.
'use strict';

import { bindImage, stageBoot, readLog, summarize, readDev } from './sr_boot_stage.js';

// ===================================================================== GUEST ADDRESSES
// Recovered by disassembly against ~/gc_refs/dolsdk2001/src/gx/*.c and src/vi/vi.c, and
// cross-checked against dolphin_captures/sab.map + tools/gsne8p.map (the two maps agree
// on 8 shared boundaries in this region).  Each is identified by the register writes its
// body performs, which is why the comment names the register set rather than a size.
// EVERY ONE of these has a `case 0x…u:` in sr_image/sr_dispatch.c and NONE is in
// skiplist.json — i.e. all of them are really translated, not stubbed.
const G = {
  // --- __start's own straight-line prologue, disassembled at 0x80003140.  Same list
  // and same order as sr_image_worker.js's WALK, minus the steps past OSInit.
  __init_registers: 0x80003254,   // r1=0x803c1450 r2=0x803b6520 r13=0x803b52c0
  __init_hardware:  0x80003330,   // HOST: MSR[FP], __OSPSInit, __OSCacheInit
  __init_data:      0x80003270,   // .data copy + .bss clear loops
  DBInit:           0x800ecf08,   // bl at 0x80003214              (sab.map)
  OSInit:           0x800e362c,   // bl at 0x80003218              (sab.map)
  main:             0x800d3ad0,   // bl at 0x8010b458              (sab.map)

  // --- VI
  VIInit:           0x800f2430,   // takes &__VIRetraceHandler -> __OSSetInterruptHandler; vi.c:358

  // --- GX.  GXInit is the one symbol a map names outright (gsne8p.map:111).
  GXInit:              0x800ff0b0,
  GXFlush:             0x801014f0, // 8x stw to 0xCC008000 then PPCSync; GXMisc.c:37
  GXSetDispCopySrc:    0x80101d94, // BP 0x49/0x4A                 GXFrameBuf.c:91
  GXSetDispCopyDst:    0x80101f14, // BP 0x4D                      GXFrameBuf.c:122
  GXSetDispCopyYScale: 0x80102170, // BP 0x4E                      GXFrameBuf.c:203
  GXSetCopyClear:      0x8010222c, // BP {0x4F,0x50,0x51}          GXFrameBuf.c:229
  GXSetCopyFilter:     0x80102294, // BP {0x01..0x04,0x53,0x54}    GXFrameBuf.c:255
  GXCopyDisp:          0x801024d8, // BP 0x4B (dest) + BP 0x52 (trigger)
  GXSetPixelFmt:       0x80105234, // p2f[] table at 0x801d2ae8    GXPixel.c:203
  GXSetZMode:          0x8010517c, // three fields on gx+0x1d8     GXPixel.c:185
  GXSetColorUpdate:    0x801050fc, // cmode0 bit 3                 GXPixel.c:169
  GXSetAlphaUpdate:    0x8010513c, // cmode0 bit 4                 GXPixel.c:177
  GXSetViewport:       0x80105aa8, // -> GXSetViewportJitter(...,1); XF 0x5101A
  GXSetScissor:        0x80105b18, // BP scissor pair              GXTransform.c:443
};
// ⚠ DELIBERATELY ABSENT: GXDrawDone (0x8010154c).  Its body inlines GXWaitDrawDone and
// SLEEPS on FinishQueue (OSSleepThread at 0x800ec890) until a PE interrupt bumps the
// DrawDone flag.  This runtime delivers NO interrupts (sr_image.c:32-42), so calling it
// is a guaranteed one-way wedge.  GXFlush does the flush half without the wait, which is
// exactly what a host-driven frame needs; gamecube/recomp/build_wasm.sh:260-264 patches
// the decomp's equivalent wait out for the identical reason on the MP4 path.

// ================================================================ GUEST MEMORY BUDGET
// Both inside MEM1 (0x80000000..0x81800000) and both above the arena SAB itself would
// hand out at this point in a boot, so nothing the prologue allocated is clobbered.
const FIFO_BASE = 0x81000000;   // GXInit's CP FIFO ring. 32-byte aligned, as GX requires.
const FIFO_SIZE = 0x00040000;   // 256 KB
const XFB_ADDR  = 0x81200000;   // 640x480 external framebuffer: 640*480*2 = 0x96000 B
const XFB_W = 640, XFB_H = 480; // ...so it ends at 0x81296000, well inside MEM1.

// GekkoState (gekko_rt.h:29-40): gpr[32] then ps0[32] then ps1[32] then the SPRs.
// gpr is 32*4 = 128 bytes and uint64_t needs 8-byte alignment, which 128 already is, so
// ps0 begins at 128.  ASSERTED against sr_state_size() at run time rather than trusted:
// a silent layout change would otherwise write float arguments into the wrong register
// and produce a wrong picture instead of an error.
const PS0_OFF = 128;
const EXPECT_STATE_SIZE = 696;  // 128 + 256 + 256 + (5*4) + (8*4) + 4

let mod = null, api = null;
function say(kind, payload) { self.postMessage(Object.assign({ kind }, payload)); }

// ------------------------------------------------------------------ CALLING THE GUEST
// GPRs by index (r3..r10 are the integer argument registers), FPRs by index (f1..f8 are
// the float argument registers).  ps0 holds the raw binary64 BITS as Dolphin stores
// them, so writing through HEAPF64 writes exactly the double a PPC caller would have
// left there — single-precision arguments are widened to double in an FPR by the ABI,
// so a `float` parameter is written the same way.
function setArgs(gpr, fpr) {
  const b = api.state() >>> 2;
  if (gpr) for (const k of Object.keys(gpr)) mod.HEAPU32[b + (+k)] = gpr[k] >>> 0;
  if (fpr) {
    // ⚠ `mod.HEAPF64` DOES NOT EXIST. build_image.sh:235 exports only
    // HEAPU8,HEAPU32,wasmMemory, and emscripten >=6 attaches ONLY what is exported
    // (src/runtime_common.js:164-171) — the same trap that made a working N64 core
    // look dead when n64/index.html read Module.HEAP16. Build the view from
    // wasmMemory.buffer instead, and build it FRESH on every call: -sALLOW_MEMORY_GROWTH
    // detaches any cached view the moment the heap grows.
    const F = new Float64Array(mod.wasmMemory.buffer);
    const f = (api.state() + PS0_OFF) >>> 3;
    for (const k of Object.keys(fpr)) F[f + (+k)] = fpr[k];
  }
}

// One guest call, with the FIFO delta it produced.  The delta is what makes a step that
// emitted NOTHING visible: a GX call that silently did nothing would otherwise be
// indistinguishable from one that worked, since sr_call returns a fault code and not a
// statement about output.
function callGuest(name, addr, gpr, fpr) {
  setArgs(gpr, fpr);
  const before = api.gxPos();
  const t0 = performance.now();
  let fault = null, threw = null;
  try { fault = api.call(addr) >>> 0; }
  catch (err) { threw = String(err && err.message || err); }
  const b = api.state() >>> 2;
  return {
    name, addr: '0x' + addr.toString(16),
    fault: fault === null ? null : '0x' + fault.toString(16),
    threw,
    ms: +(performance.now() - t0).toFixed(2),
    fifoDelta: api.gxPos() - before,
    writes: api.gxWrites(),
    r3: '0x' + (mod.HEAPU32[b + 3] >>> 0).toString(16),
  };
}

// ------------------------------------------------------- GXColor IS PASSED BY REFERENCE
// ⚠ NOT by value in a GPR, which is what the PowerPC EABI does with a 4-byte struct and
// what the first draft of this file assumed. THE SHIPPED BYTES SETTLE IT — fn_8010222c's
// first two instructions dereference r3:
//     80102230  88830003   lbz r4, 3(r3)      <- clear_clr.a
//     80102234  88a30000   lbz r5, 0(r3)      <- clear_clr.r
// so r3 is a POINTER to the four bytes {r,g,b,a}, not the four bytes.
//
// HOW THE WRONG VERSION FAILED, because it is worth knowing that it did not fail loudly:
// passing the packed word 0x1E66C8FF put that value in r3, the guest dereferenced it, and
// gekko_rt.h:97 faulted with 0x8266C902 — which is exactly (0x1E66C8FF + 3) & 0x03FFFFFF,
// the +3 load above. But `gk_r8` RETURNS 0 on a fault and the emitted bodies have no fault
// check between instructions, so GXSetCopyClear went on to write a perfectly well-formed
// BP 0x4F/0x50/0x51 triple carrying the colour BLACK. The stream was valid, the pipeline
// drew it correctly, and the screen was black — a wrong ANSWER, not a broken renderer.
// The only tell was the fault code, which is why every step's fault is logged.
const COLOR_EA = 0x81300000;   // 4-byte staging slot in MEM1, above the XFB's 0x81296000 end

// Write a GXColor into guest memory and return its guest address, for passing in a GPR.
function stageColor(ea, c) {
  const p = api.ram() + (ea & 0x03FFFFFF);
  mod.HEAPU8[p] = c.r & 255; mod.HEAPU8[p + 1] = c.g & 255;
  mod.HEAPU8[p + 2] = c.b & 255; mod.HEAPU8[p + 3] = c.a & 255;
  return ea >>> 0;
}

// ===================================================================== THE DRIVE PROGRAM
// SAB's own GX entry points, called in the order the SDK requires, with the arguments a
// caller would pass.  Nothing here writes a FIFO byte: every byte is produced by the
// translated guest bodies these calls enter.
//
// The clear colour is deliberately a value nothing else in the pipeline produces, so a
// picture in that colour cannot be a stale JIT frame, a cleared canvas, or a default:
// it can only have come from GXSetCopyClear's BP 0x4F/0x50 writes flowing through the
// captured stream into Dolphin's EFB clear.  Black would have proved nothing.
const CLEAR = { r: 0x1E, g: 0x66, b: 0xC8, a: 0xFF };

function gxSetup(steps) {
  // GXInit(base, size) -> GXFifoObj*.  Programs the CP/PE registers (a backing buffer
  // here, harmlessly) and pushes the whole GX default state through WPAR — which is the
  // register prologue every later frame in this stream depends on.
  steps.push(callGuest('GXInit', G.GXInit, { 3: FIFO_BASE, 4: FIFO_SIZE }));

  // GXSetViewport(left, top, wd, ht, nearZ, farZ) — all six in f1..f6.
  steps.push(callGuest('GXSetViewport', G.GXSetViewport, null,
                       { 1: 0, 2: 0, 3: XFB_W, 4: XFB_H, 5: 0, 6: 1 }));
  steps.push(callGuest('GXSetScissor', G.GXSetScissor, { 3: 0, 4: 0, 5: XFB_W, 6: XFB_H }));

  // GX_PF_RGB8_Z24 = 0, GX_ZC_LINEAR = 0.
  steps.push(callGuest('GXSetPixelFmt', G.GXSetPixelFmt, { 3: 0, 4: 0 }));
  // GXSetZMode(compare_enable, func, update_enable): GX_TRUE, GX_LEQUAL = 3, GX_TRUE.
  steps.push(callGuest('GXSetZMode', G.GXSetZMode, { 3: 1, 4: 3, 5: 1 }));
  steps.push(callGuest('GXSetColorUpdate', G.GXSetColorUpdate, { 3: 1 }));
  steps.push(callGuest('GXSetAlphaUpdate', G.GXSetAlphaUpdate, { 3: 1 }));

  // The display-copy rectangle.  Without these the copy's source size and destination
  // stride are whatever GXInit's defaults are, and the XFB comes out misshapen.
  steps.push(callGuest('GXSetDispCopySrc', G.GXSetDispCopySrc, { 3: 0, 4: 0, 5: XFB_W, 6: XFB_H }));
  steps.push(callGuest('GXSetDispCopyDst', G.GXSetDispCopyDst, { 3: XFB_W, 4: XFB_H }));
  steps.push(callGuest('GXSetDispCopyYScale', G.GXSetDispCopyYScale, null, { 1: 1.0 }));
  // GXSetCopyFilter(aa, sample_pattern, vf, vfilter).  aa=GX_FALSE and vf=GX_FALSE are
  // the arm in which the two pointer arguments are never dereferenced, so passing NULL
  // for both is correct rather than lucky (GXFrameBuf.c:255).
  steps.push(callGuest('GXSetCopyFilter', G.GXSetCopyFilter, { 3: 0, 4: 0, 5: 0, 6: 0 }));

  // GXSetCopyClear(GXColor clear_clr, u32 clear_z).  r3 is a POINTER to the colour (see
  // the note beside stageColor); 0x00FFFFFF is GX_MAX_Z24.
  steps.push(callGuest('GXSetCopyClear', G.GXSetCopyClear,
                       { 3: stageColor(COLOR_EA, CLEAR), 4: 0x00FFFFFF }));
  steps.push(callGuest('GXFlush', G.GXFlush));
}

// ONE FRAME.  GXCopyDisp(dest, clear) emits BP 0x4B with dest>>5 — which is the write
// worker_funcs.js:938-943 scans for to decide where recomp_present reads the XFB from —
// then BP 0x52 to trigger the EFB->XFB copy.
//
// clear=GX_TRUE means "copy, THEN clear the EFB to the copy-clear colour", so the FIRST
// copy carries whatever an uninitialised EFB holds and the SECOND onwards carry CLEAR.
// That ordering is a property of the hardware, not a workaround, and it is why the drive
// issues more than one frame before anything is claimed about the colour.
function gxFrame(steps, n, cycle) {
  // ---- THE ANTI-STALENESS ARM.
  // `drawn/s` (a delta of Dolphin's PE SetFinish counter) is structurally ZERO on this
  // path, and reading the translated bytes says exactly why: the ONLY guest writer of the
  // finish token is GXDrawDone (fn_8010154c), which writes 0x45000002 to WPAR at guest
  // 0x80101574 and then, at L_801015a4, spins on `gk_r8(r13 - 29408)` — a flag that ONLY
  // a PE FINISH interrupt sets, and this runtime delivers no interrupts. So the token
  // cannot be emitted without wedging, and synthesizing it here would be fabricating the
  // very counter being reported.
  //
  // What that counter is FOR, though, is refuting a stale frame — and that can be shown
  // directly and more strongly: change the picture and see whether the screen follows. A
  // stale frame cannot. With `cycle` on, the clear colour is re-staged every frame from
  // the frame number, so the canvas must be a different colour at two different sample
  // times or the pipeline is not live. Every byte is still the guest's: this changes the
  // ARGUMENT to SAB's own GXSetCopyClear, not the stream.
  if (cycle) {
    const t = n * 0.06;
    const c = { r: (Math.sin(t) * 110 + 130) | 0,
                g: (Math.sin(t + 2.09) * 110 + 130) | 0,
                b: (Math.sin(t + 4.19) * 110 + 130) | 0, a: 255 };
    steps.push(callGuest('GXSetCopyClear', G.GXSetCopyClear,
                         { 3: stageColor(COLOR_EA, c), 4: 0x00FFFFFF }));
  }
  steps.push(callGuest('GXCopyDisp', G.GXCopyDisp, { 3: XFB_ADDR, 4: 1 /* GX_TRUE */ }));
  steps.push(callGuest('GXFlush', G.GXFlush));
}

// ------------------------------------------------------------------------- THE MESSAGE
// Field-for-field the contract recomp_worker.js:1056 posts and gamecube.html:7745
// relays.  `regions` is always empty here (see the header: MEM1 is authoritative), and
// `mem1` goes out ONCE — the guest is not running between driven frames, so resending
// 24 MB per frame would copy an image that cannot have changed.
//
// EVERY FRAME IS SELF-CONTAINED, and it has to be: the consumer may skip a frame's draw
// entirely (`skipRender`, worker_funcs.js:932), so CP/XF/BP state carried only by a
// skipped frame would be lost.  recomp_worker.js:1048-1053 solves that by prepending a
// SYNTHESIZED register shadow it maintains itself.  This path prepends the real thing:
// `prologue` is the byte stream SAB's own GXInit and GX state calls pushed through WPAR,
// captured once and replayed verbatim ahead of each frame's copy commands.  It is the
// guest's register state because it IS the guest's register writes.
let prologue = new Uint8Array(0);

function postFrame(n, withMem1) {
  const pos = api.gxPos(), base = api.gxBase();
  const tail = mod.HEAPU8.subarray(base, base + pos);
  const fifo = new Uint8Array(prologue.length + tail.length);
  fifo.set(prologue, 0);
  fifo.set(tail, prologue.length);
  const transfers = [fifo.buffer];
  let mem1 = null;
  if (withMem1) {
    const r = api.ram();
    mem1 = mod.HEAPU8.slice(r, r + api.ramSize()).buffer;
    transfers.push(mem1);
  }
  // ⚠ MEASURE BEFORE TRANSFERRING. postMessage with a transfer list DETACHES these
  // buffers, and a detached TypedArray reports `.length === 0` — so reading the sizes
  // after the post would report "0 bytes posted" for a frame that was fully populated.
  // That is a false zero of exactly the shape this repo has been burned by before.
  const sizes = { n, fifoBytes: fifo.length, tailBytes: tail.length,
                  mem1Bytes: mem1 ? mem1.byteLength : 0 };
  self.postMessage({ cmd: 'frame', n, fifo: fifo.buffer, mem1, regions: [] }, transfers);
  // Cut the capture back to empty now that this frame's tail has been copied out. The
  // prologue is held in JS, not in the wasm buffer, so the 8 MB capture never fills and
  // the posted stream stays a constant size instead of growing without bound.
  api.gxReset();
  return sizes;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.cmd !== 'boot') return;
  const base = msg.base || './';
  // mode 'gx'   — drive SAB's GX entry points to a picture (the default).
  // mode 'main' — call SAB's own main() under the watchdog and report how much WPAR
  //               traffic the GAME produces unaided.  This is the measurement arm, and
  //               it is the one that would retire the hand-driving if it ever produced
  //               a frame's worth of FIFO on its own.
  const mode = msg.mode === 'main' ? 'main' : 'gx';
  // THE FALSIFYING CONTROL ARM, on ONE binary with ONE md5: with capture off, sr_gx.c
  // still COUNTS the WPAR stores but keeps no bytes, so the stream is empty and no frame
  // can be posted.  A picture that appears in both arms did not come from this capture.
  const capture = msg.capture === 0 ? 0 : 1;
  // 0 (the default) = run until the worker is terminated. See the note beside `tick`.
  const frames = msg.frames | 0;
  // ?srcolor=cycle -> re-stage the clear colour every frame (see gxFrame).
  const cycle = !!msg.colorCycle;

  try {
    say('status', { text: 'loading module' });
    const factory = (await import(base + 'sab_image.mjs')).default;
    mod = await factory();
    api = bindImage(mod, {
      gxSetCapture: '_sr_gx_set_capture', gxGetCapture: '_sr_gx_get_capture',
      gxBase: '_sr_gx_fifo_base', gxPos: '_sr_gx_fifo_pos', gxCap: '_sr_gx_fifo_cap',
      gxReset: '_sr_gx_fifo_reset', gxWrites: '_sr_gx_writes', gxBytes: '_sr_gx_bytes',
      gxDropped: '_sr_gx_dropped', gxOffMax: '_sr_gx_off_max',
    });
    if (!api.init()) throw new Error('sr_image_init() returned 0');

    // Layout guard — see the note beside PS0_OFF.  A mismatch here means float arguments
    // would land in the wrong place, so it is fatal rather than a warning.
    const stateSize = api.stateSize();
    if (stateSize !== EXPECT_STATE_SIZE)
      throw new Error('GekkoState is ' + stateSize + ' bytes, expected ' + EXPECT_STATE_SIZE +
                      ' — the ps0 offset this worker writes float arguments through is stale');

    api.setExiModel(1);
    api.setStrict(0);
    api.setWatchdog((msg.watchdog | 0) || 2000000);
    api.gxSetCapture(capture);
    // SR_OS_CTX (sr_host_os.h:53) = SR_OS_IRQ plus the three context primitives.
    // MEASURED, not assumed: with the SR_OS_IRQ default that sr_image_init() installs,
    // OSInit returns fault=0xC60E55D4 — an UNIMPL boundary naming 0x800e55d4
    // OSSetCurrentContext, the one function sr.py genuinely refuses (mfmsr). GX runs on
    // the OS state OSInit leaves behind, so it is worth clearing that before driving it.
    // Still no host thread and no -pthread; ?srosmode= overrides for an A/B.
    const osMode = (msg.osMode === undefined || msg.osMode === null) ? 4 : (msg.osMode | 0);
    api.osMode(osMode);

    const staged = await stageBoot(mod, api, base);
    say('ready', {
      mode, capture, frames, cycle, stateSize, osMode: api.osGetMode(),
      ramSize: api.ramSize(), fifoCap: api.gxCap(),
      dolBytes: staged.dolBytes, fst: staged.fst,
      addrs: Object.fromEntries(Object.entries(G).map(([k, v]) => [k, '0x' + v.toString(16)])),
    });

    // ---- THE PROLOGUE.  __start's own straight-line call sequence up to and including
    // OSInit, exactly as sr_image_worker.js's WALK runs it and README §10 measured it
    // (all four return fault-free; OSInit reaches 27 device registers).  The GX library
    // needs OSInit's heap, interrupt table and console type, so this is a prerequisite,
    // not scaffolding.
    const steps = [];
    for (const [name, addr] of [['__init_registers', G.__init_registers],
                                ['__init_hardware',  G.__init_hardware],
                                ['__init_data',      G.__init_data],
                                ['DBInit',           G.DBInit],
                                ['OSInit',           G.OSInit]]) {
      const rec = callGuest(name, addr);
      steps.push(rec);
      say('step', rec);
      if (rec.threw) throw new Error('prologue step ' + name + ' aborted: ' + rec.threw);
    }
    const fifoAfterPrologue = api.gxPos();

    if (mode === 'main') {
      // THE UNAIDED ARM.  No GX driving at all — just SAB's own main(), under the
      // watchdog, and then the honest count of what it produced by itself.
      const rec = callGuest('main', G.main);
      steps.push(rec);
      say('step', rec);
      say('done', {
        mode, capture, steps,
        gx: { writes: api.gxWrites(), bytes: api.gxBytes(), captured: api.gxPos(),
              dropped: api.gxDropped(), offMax: api.gxOffMax() },
        fifoAfterPrologue,
        dev: readDev(mod, api), log: summarize(readLog(mod, api)),
      });
      return;
    }

    // ---- THE GX DRIVE.
    gxSetup(steps);
    for (const s of steps.slice(-13)) say('step', s);

    // FREEZE THE GUEST'S OWN INIT STREAM as the per-frame prologue, then cut the capture
    // so each later read holds only that frame's copy commands.  With the capture arm
    // OFF this is legitimately empty, and every frame posted below is empty with it —
    // which is the control arm doing its job, not a bug.
    prologue = mod.HEAPU8.slice(api.gxBase(), api.gxBase() + api.gxPos());
    api.gxReset();

    say('setup-done', {
      prologueBytes: prologue.length,
      gxWrites: api.gxWrites(), gxBytes: api.gxBytes(), offMax: api.gxOffMax(),
      steps: steps.slice(-13),
    });

    const posted = [];
    let n = 0;
    // frames <= 0 means RUN UNTIL STOPPED.  That is the arm a drawn/s measurement needs:
    // drawn/s is a DELTA of Dolphin's PE SetFinish counter over a sampling window
    // (dolphin_render_probe.js:1192), so a fixed burst of a few frames reads as a blip
    // and then zero.  A picture that only exists for eight frames has not been shown.
    const tick = () => {
      gxFrame(steps, n, cycle);
      // mem1 on the first frame only: the consumer has no other way to seed guest RAM
      // (worker_funcs.js:921-922), and nothing moves it afterwards on this path.
      if (steps.length > 400) steps.splice(0, steps.length - 400);
      posted.push(postFrame(n, n === 0));
      if (posted.length > 4) posted.shift();
      n++;
      if (n === 1 || n === 8 || n % 60 === 0)
        say('frames', { n, last: posted[posted.length - 1], prologueBytes: prologue.length,
                        gxWrites: api.gxWrites(), gxBytes: api.gxBytes() });
      if (frames <= 0 || n < frames) { setTimeout(tick, 16); return; }
      say('done', {
        mode, capture, frames: n, steps, posted,
        gx: { writes: api.gxWrites(), bytes: api.gxBytes(), prologue: prologue.length,
              dropped: api.gxDropped(), offMax: api.gxOffMax(), cap: api.gxCap() },
        fifoAfterPrologue,
        xfb: '0x' + XFB_ADDR.toString(16), clear: CLEAR,
        dev: readDev(mod, api), log: summarize(readLog(mod, api)),
      });
    };
    tick();
  } catch (err) {
    say('error', { message: String(err && err.message || err), stack: String(err && err.stack || '') });
  }
};
