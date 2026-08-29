// Bundled into dolphin_worker.js via emcc --post-js.
// Routes messages from main thread into the Dolphin core.

// [FIX#1 render-worker] installGLRecorder MUST be defined on BOTH worker-main
// AND the proxy-pthread, because Dolphin's GL backend (load_iso -> ContextReset
// -> retro_run, all on the proxy-pthread per EmscriptenWorker.cpp) is where the
// _glXXX calls execute, so the recording GLctx must be installed into THAT
// thread's GL/GLctx. JS-object SABs do NOT propagate to emscripten pthreads, so
// the GL command ring + ctrl block are embedded in the shared wasm heap at fixed
// byte offsets; the page writes a descriptor at GL_DESC_OFF (magic, ringOff,
// ringWords, ctrlOff, enabled) that BOTH threads read from the shared heap.
//
//   ── UNCERTAIN STEP (must be probe-confirmed) ──────────────────────────────
//   GL_RING_OFF / GL_CTRL_OFF (0x08000000 / 0x09100000) are chosen in the gap
//   between the scratch SAB region (ends ~0x026Bxxxx) and Dolphin's data section
//   (GLOBAL_BASE=0x10000000). They are unreferenced in sab_layout.h, but I have
//   NOT verified the wasm STACK (STACK_SIZE=8MB) or low malloc arena doesn't
//   reach 0x08000000. The probe's first run will show [fix1] gl-error / wrong
//   render if these collide; bump them (e.g. to just-below 0x10000000) if so.
var GL_DESC_OFF  = 0x07FF0000;  // descriptor: i32[0]=magic i32[1]=ringByteOff i32[2]=ringWords i32[3]=ctrlByteOff i32[4]=enabled
var GL_DESC_MAGIC = 0x474C5244; // 'GLRD'
var __gcRec = null;
self.installGLRecorder = function () {
  try {
    if (typeof GL === 'undefined') { postMessage({ cmd: 'print', txt: '[fix1] GL undefined on this thread' }); return 0; }
    var R = self.__GLRecord;
    if (!R || !R.GLRecorder) {
      // gl-record.js wasn't importScripts'd on THIS thread. On the pthread the
      // shim doesn't run, so load it here (same-origin, defines self.__GLRecord).
      try { importScripts('/gamecube/gl-record.js'); R = self.__GLRecord; } catch (e) {}
    }
    if (!R || !R.GLRecorder) { postMessage({ cmd: 'print', txt: '[fix1] __GLRecord unavailable on this thread' }); return 0; }
    var heap32 = Module.HEAPU32 || new Uint32Array(Module.HEAPU8.buffer);
    if (heap32[GL_DESC_OFF >> 2] !== GL_DESC_MAGIC || heap32[(GL_DESC_OFF >> 2) + 4] !== 1) {
      postMessage({ cmd: 'print', txt: '[fix1] GL descriptor absent/disabled at 0x' + GL_DESC_OFF.toString(16) }); return 0;
    }
    var ringByteOff = heap32[(GL_DESC_OFF >> 2) + 1];
    var ringWords   = heap32[(GL_DESC_OFF >> 2) + 2];
    var ctrlByteOff = heap32[(GL_DESC_OFF >> 2) + 3];
    var buf = Module.HEAPU8.buffer;
    var ringView = new Int32Array(buf, ringByteOff, 4 + ringWords);
    var ctrlView = ctrlByteOff ? new Int32Array(buf, ctrlByteOff, 256) : null;
    // OVERLAY mode: EmscriptenWorker.cpp already created a REAL WebGL2 context
    // via emscripten_webgl_create_context("#canvas") (on the throwaway 1x1
    // hwOffscreenCanvas) and made it current, so Dolphin's get_proc_address has
    // resolved against a real emscripten context. We now overlay the recorder on
    // THAT context: caps/proc-addresses stay real; draw/state/upload calls divert
    // to the ring. We do NOT create our own context (GL.createContext bypassed
    // get_proc_address and left a null function at boot).
    var cur = GL.currentContext;
    if (!cur || !cur.GLctx) {
      postMessage({ cmd: 'print', txt: '[fix1] no current GL context to overlay' }); return 0;
    }
    var handle = cur.handle;
    var qctx = cur.GLctx;                      // the REAL WebGL2 context — caps + fallback
    __gcRec = new R.GLRecorder(ringView, function () { return Module.HEAPU8; }, qctx, ctrlView);
    // Recorder records the 65-method draw surface; falls back to the real context
    // for any other method (init queries, get_proc_address existence checks).
    var recGL = R.makeRecordingGL(__gcRec, qctx);
    Module.__gcGlEmitPresent = function () { recGL.present(); };
    // OVERLAY: replace the real context's GLctx with the recorder, then re-make
    // current so the module-scoped GLctx (read by every _glXXX on this thread)
    // becomes the recorder. GL.currentContext keeps its real defaultFbo/handle.
    cur.GLctx = recGL;
    if (typeof GL.makeContextCurrent === 'function' && handle != null) GL.makeContextCurrent(handle);
    else if (typeof GLctx !== 'undefined') GLctx = recGL;
    postMessage({ cmd: 'print', txt: '[fix1] recording GLctx OVERLAY on handle=' + handle
      + ' ring@0x' + ringByteOff.toString(16) + ' words=' + ringWords + ' caps=' + (!!qctx) + ' ctrl=' + (!!ctrlView) });
    return 1;
  } catch (e) {
    postMessage({ cmd: 'print', txt: '[fix1] installGLRecorder failed: ' + (e && e.message ? e.message : e) });
    return 0;
  }
};

// Skip the message-routing half entirely in pthread child workers — they have
// their own onmessage handler installed by emscripten's pthread runtime.
if (typeof ENVIRONMENT_IS_PTHREAD === 'undefined' || !ENVIRONMENT_IS_PTHREAD) {

// 4f-6: surface a 'runtime-ready' postMessage when emscripten has
// finished bringing up wasm + memory + exports. Page waits on this
// before routing real MMIO cmds (2..12) — earlier calls hit
// throwing stubs because Module.calledRun isn't reliable under
// PROXY_TO_PTHREAD on the main thread.
if (typeof Module !== 'undefined') {
  var _ppc_origORI = Module.onRuntimeInitialized;
  Module.onRuntimeInitialized = function () {
    if (typeof _ppc_origORI === 'function') {
      try { _ppc_origORI(); } catch (e) {}
    }
    // 2e.4 (UPDATED 2026-05-11): PowerPCState redirect moved to
    // load_iso() in EmscriptenWorker.cpp. Under PROXY_TO_PTHREAD the
    // onRuntimeInitialized callback runs on the worker-main wasm
    // instance, but PowerPCManager is constructed on the proxy-pthread
    // wasm instance — file-static `g_ppc_state_external_storage` is
    // per-instance, so setting it from here never reaches the pthread
    // that needs it. Same bug class as g_jit_wasm (JitWasm.cpp:1525).
    postMessage({ cmd: 'print', txt: '[worker] PowerPCState redirect deferred to load_iso (pthread instance)' });
    postMessage({ cmd: 'runtime-ready' });
    postMessage({ cmd: 'print', txt: '[worker] runtime-ready posted' });

    // [AOT v4 reloc 2026-08-13] psmtxro.bjaot (v2 per-block) fetch DISABLED:
    // every offline v2 asset bakes the native tool's ASLR-slid &g_bem_* — its
    // promote-prologue stray-writes worker heap on EVERY execution (the
    // wild-address class, A3_plan.md). Re-enable only with a v4-per-block
    // regen (reloc table + seal-time patching).
    // (The A1 per-block load path itself is unchanged and stays proven.)

    // [AOT A3.1] MERGED whole-function asset (BJAOTM) — same choreography, its
    // own SAB cells (len 0x026B3494 first, ptr 0x026B3490 last = the trigger).
    try {
      fetch('/gamecube/dolphin_libretro/handlereverb.bjaotm')
        .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
        .then(function (ab) {
          if (!ab || !Module._malloc) return;
          var bytes = new Uint8Array(ab);
          var ptr = Module._malloc(bytes.length);
          if (!ptr) return;
          Module.HEAPU8.set(bytes, ptr);
          var h32 = Module.HEAPU32 || new Uint32Array(Module.HEAPU8.buffer);
          h32[0x026B3494 >> 2] = bytes.length >>> 0;  // len first
          Atomics.store(h32, 0x026B3490 >> 2, ptr >>> 0);  // ptr last (trigger)
          postMessage({ cmd: 'print', txt: '[worker][aot] handlereverb.bjaotm streamed: ' + bytes.length + ' bytes @0x' + (ptr >>> 0).toString(16) });
        })
        .catch(function (e) {
          postMessage({ cmd: 'print', txt: '[worker][aot] merged asset fetch failed: ' + e });
        });
    } catch (e) {}
  };
}

var romChunks = [];
var totalSize = 0;
var bootStarted = false;
var tickInterval = null;
var firstFrameSeen = false;
var bootLoopRunning = false;

// During boot (before any frame is produced), run flat-out: drain a large
// batch via _run_iter_batch then yield to the event loop via setTimeout(0)
// so messages still get processed. The 60 Hz setInterval pace is correct
// for a running game (matches GC VBlank) but throttles us 10–16× during
// early OS init when there's no rendering budget to fill. After the first
// frame arrives we switch to the steady-state 60 Hz loop.
// [tick-diag 2026-06-12] temporary (strip per gate #8): pin WHERE the
// worker's event loop dies. mailbox-diag proved zero inbound deliveries
// post-romEnd; the discriminator is whether _run_iter_batch ever RETURNS.
// If "[tick-diag] boot batch 1 returned" never prints, the first batch
// call blocks forever. If boot batches return but "[tick-diag] tick N"
// never prints, the setInterval callback is starved some other way.
var __bootBatches = 0;
var __ticks = 0;

// [recomp-seam DIAG 2026-08-21 — strip per gate #8] Prove the recomp_render_fifo seam:
// build one big-endian GP-FIFO colored-triangle stream (byte-identical to what the
// decomp→wasm recomp emits) and hand it to Dolphin's LIVE WGPU renderer. Fully
// self-contained render state (VCD/VAT/XF/BP/GX_PASSCLR TEV) so it does not depend on
// MP4's live state. All encodings cited to Dolphin source (CPMemory.h/XFMemory.h/BPMemory.h).
var __recompFrame = 0, __recompPtr = 0, __recompBytes = null;
// [recomp-bridge] armed by the 'recompFix' message (see its case below)
var __recompFix = null, __recompFixApplied = false, __recompFixPtr = 0, __recompFixLen = 0,
    __recompFixPumps = 0, __recompPauseCpu = false, __recompXfbAddr = 0,
    __recompLive = false, __recompLiveXfb = 0, __recompLivePtr = 0, __recompLiveCap = 0, __recompLiveFrames = 0, __vtxCensusPtr = 0;
var __recompT = { prep: 0, fifo: 0, present: 0, n: 0, regB: 0, fifoB: 0, skip: 0 };
function recompFixApply() {
  // park the emulated CPU FIRST (CPUManager::Break -> JitWasm::Run exits) so the RAM image
  // overwrite below cannot race the live JIT guest; retro_run keeps pumping GPU slice/present.
  if (__recompFix.pauseCpu && Module._recomp_pause_cpu) Module._recomp_pause_cpu();
  var ram = Module._dolphin_get_ram_addr();
  if (__recompFix.mem1) {
    Module.HEAPU8.set(new Uint8Array(__recompFix.mem1), ram);
    var regs = __recompFix.regions;
    if (regs && regs.arrays) {
      var h = Module.HEAPU8;
      for (var ai = 0; ai < regs.arrays.length; ai++) {
        var A = regs.arrays[ai];
        if (A.stride !== 8 && A.stride !== 12) continue;      // f32-based arrays only
        var off = ram + (A.base & 0x01FFFFFF), n = A.count & ~3;
        for (var k = 0; k < n; k += 4) {
          var t0 = h[off + k]; h[off + k] = h[off + k + 3]; h[off + k + 3] = t0;
          var t1 = h[off + k + 1]; h[off + k + 1] = h[off + k + 2]; h[off + k + 2] = t1;
        }
      }
    }
  }
  // Presentation: present the RECOMP's OWN display-copy destination. The old approach —
  // retargeting every display-copy BP 0x4B to the JIT game's VI XFB (TFBL) — made the 614KB
  // XFB write land at the JIT-era address INSIDE the recomp guest's live heap: at the board
  // it overwrote 0x1e6c00..0x27cc00 every pump, right across the window font at 0x25c220
  // ("barcode text" = the font sheet re-decoded from XFB YUV bytes; proven 2026-08-27 by
  // recompPeek 01FE01FE at 0x25c220 + the empty-fifo control run staying clean).
  // recomp_present(xfb_addr) presents an explicit address, so no retarget is needed: the
  // final 0x4B in the stream is the display copy (GXCopyDisp at frame end) — its dest is the
  // recomp game's own XFB allocation, safe by the game's own memory layout.
  var fifoBytes = new Uint8Array(__recompFix.fifo);
  var xfbAddrBytes = 0, patched = 0;
  {
    var lastVal = 0;
    for (var pi = 0; pi + 4 < fifoBytes.length; pi++)
      if (fifoBytes[pi] === 0x61 && fifoBytes[pi + 1] === 0x4B)
        lastVal = (fifoBytes[pi + 2] << 16) | (fifoBytes[pi + 3] << 8) | fifoBytes[pi + 4];
    xfbAddrBytes = (lastVal << 5) >>> 0;
  }
  var tfbl = 0, bp4B = (xfbAddrBytes >>> 5) & 0x00FFFFFF;
  // skipDL bisect: NOP out CALL_DL commands (9 bytes each) so only the self-contained
  // top-level (2D sprite/window) layer renders.
  var nopped = 0;
  if (__recompFix.skipDL) {
    for (var qi = 0; qi + 9 <= fifoBytes.length; qi++) {
      if (fifoBytes[qi] === 0x40 && fifoBytes[qi + 1] === 0x80) {
        for (var z = 0; z < 9; z++) fifoBytes[qi + z] = 0x00;
        nopped++; qi += 8;
      }
    }
  }
  __recompFixPtr = Module._malloc(fifoBytes.length);
  Module.HEAPU8.set(fifoBytes, __recompFixPtr);
  __recompFixLen = fifoBytes.length;
  __recompFixApplied = true;
  __recompXfbAddr = xfbAddrBytes >>> 0;
  postMessage({ cmd: 'print', txt: '[recompFix] ram=0x' + (Module._dolphin_get_ram_addr() >>> 0).toString(16)
    + ' tfbl=0x' + tfbl.toString(16) + ' xfbAddr=0x' + xfbAddrBytes.toString(16) + ' bp4B=0x' + bp4B.toString(16) + ' patched=' + patched + ' dlNopped=' + nopped });
  postMessage({ cmd: 'recompFix-applied', fifoLen: __recompFixLen });
}
function buildRecompTriangleFifo() {
  var b = [];
  function u8(v){ b.push(v & 0xff); }
  function u16(v){ u8(v>>>8); u8(v); }
  function u32(v){ v>>>=0; u8(v>>>24); u8(v>>>16); u8(v>>>8); u8(v); }
  var _fb = new ArrayBuffer(4), _f = new Float32Array(_fb), _u = new Uint32Array(_fb);
  function f32(v){ _f[0]=v; u32(_u[0]); }                       // IEEE-754 big-endian
  function cp(addr,val){ u8(0x08); u8(addr & 0xff); u32(val); } // LOAD_CP_REG
  function xf(base, words){ u8(0x10); u32((((words.length-1)&0xf)<<16)|(base&0xffff)); for(var k=0;k<words.length;k++){ var w=words[k]; if(w&&w.f!==undefined) f32(w.f); else u32(w>>>0); } }
  var F=function(x){return {f:x};};
  function bp(reg,val24){ u8(0x61); u32(((reg&0xff)<<24)|(val24&0xffffff)); } // LOAD_BP_REG
  // CP: VCD + VAT (pos DIRECT xyz-float, color0 DIRECT RGBA8888)
  cp(0x50, 0x00002200); cp(0x60, 0x00000000);
  cp(0x70, 0x40016009); cp(0x80, 0x80000000); cp(0x90, 0x00000000);
  // XF: identity posmtx0, 1 color chan (vertex/unlit), 0 texgens, viewport, ortho proj
  xf(0x0000, [F(1),F(0),F(0),F(0),  F(0),F(1),F(0),F(0),  F(0),F(0),F(1),F(0)]);
  xf(0x1009, [1]);                      // SETNUMCHAN=1
  xf(0x100e, [0x00000001]);             // SETCHAN0_COLOR: matsource=Vertex, unlit
  xf(0x103f, [0]);                      // SETNUMTEXGENS=0
  xf(0x101a, [F(320),F(-240),F(16777215),F(662),F(582),F(16777215)]);  // VIEWPORT 640x480
  xf(0x1020, [F(1),F(0),F(1),F(0),F(-1),F(0), 1]);                      // PROJECTION ortho identity
  // BP: genmode/zmode/blend/alpha + TEV stage0 GX_PASSCLR (pass vertex color)
  bp(0x00, 0x000010); bp(0x40, 0x00001F); bp(0x41, 0x000018); bp(0xF3, 0x000000);
  bp(0xC0, 0x08FFFA); bp(0xC1, 0x08FFD0);
  // PRIMITIVE: GX_DRAW_TRIANGLES vat0 = 0x90, 3 verts, 16B each (3 f32 pos + RGBA8)
  u8(0x90); u16(3);
  f32(0.0);  f32(0.6);  f32(0.5);  u8(255); u8(0);   u8(0);   u8(255);   // top red
  f32(-0.6); f32(-0.5); f32(0.5);  u8(0);   u8(255); u8(0);   u8(255);   // left green
  f32(0.6);  f32(-0.5); f32(0.5);  u8(0);   u8(0);   u8(255); u8(255);   // right blue
  return new Uint8Array(b);
}

// 2026-06-12 EVENT-LOOP STARVATION FIX: the old batch sizes (100000 boot /
// 10000 tick) date from when one iter was a cheap dispatch slice. Today one
// iter = one full retro_run frame-quantum (measured via the SAB counter at
// 0x025010D4: retror 0->315 across a 60s MP4 probe, ~5/s wall), so the FIRST
// boot batch alone needed ~100000/5 s of wall time — the worker never
// returned to its event loop and NO page->worker message (input, get-ram-
// info) was ever delivered post-romEnd ([mailbox-diag] n=1 cmd=romEnd was
// the lifetime total). Pump with a wall-clock budget instead: run retro_run
// repeatedly until BUDGET_MS elapses, then yield so queued messages deliver.
// [determinize-boot 2026-07-08] REPLACED the wall-clock budget (while performance.now()-t0
// < 40ms) with a FIXED ITERATION COUNT. The wall-loop ran a VARIABLE number of retro_run
// quanta per pump (however many fit in 40ms — JIT-warmup/GC/scheduler dependent), so the
// dolphin-driven boot reached different points at the same wall time → the two-run diff
// showed snap0 divergence (det_A xpc=800bffc8 vs det_B 800c0008, same input). A fixed count
// makes each pump advance the guest a DETERMINISTIC amount per pump. One retro_run quantum
// = ~one dispatch slice; PUMP_BATCH_ITERS ~40ms-equivalent at boot pace but constant.
// [present-cadence 2026-07-13] 16 -> 2. WGPU readback map callbacks (and ALL worker JS events)
// resolve only in the yield BETWEEN batches. At 16 quanta/batch the menu yielded ~16x/s and
// presents capped at 16fps with the emulator itself at ~90 VI/s (frame=11ms, jit=9ms); the
// movie yielded ~0.9x/s -> 2.6fps. 2 keeps the fixed-count determinism contract (constant
// guest-advance per pump), just yields ~8x more often so presents track the emulated rate.
var PUMP_BATCH_ITERS = 2;

function pumpBatch() {
  // [savestate-fix PM61] while DoState serializes on the CPU/EmuThread, skip the
  // GPU pump so RunGpuLoopSlice can't race the memory/GPU restore. Gated on the
  // SERVING flag (set only DURING DoState, not on the request) so the EmuThread is
  // still fed until it enters the save; the tick loop keeps yielding so the
  // EmuThread's proxied DoState calls still complete.
  if (Module && Module._bem_is_state_serving && Module._bem_is_state_serving()) {
    // [savestate-fix PM61c] Still skip RunGpuLoopSlice (would race the RAM restore),
    // but DRAIN AsyncRequests here on the message thread: a LOAD runs with
    // passthrough=false so the video-backend DoState (texture cache → WebGPU
    // createTexture) is QUEUED and the EmuThread blocks on it. This thread owns the
    // WebGPU device, so PullEvents runs that restore correctly and unblocks the load.
    if (Module._bem_drain_async) Module._bem_drain_async();
    return;
  }
  if (Module && Module._run_iter_batch) {
    // [recomp perf 2026-08-28] Once the recomp worker is driving the game, dolphin
    // is ONLY the renderer — its own emulation loop is redundant work on the very
    // thread that has to decode the FIFO. The profile shows that overhead plainly:
    // Libretro::Options::IsUpdated 3.8% and _emscripten_get_now 4.2% of this
    // worker, neither of which belongs in a render path. Skip the core pump while
    // recomp is live; frames arrive as messages and render through
    // _recomp_render_fifo, not through this pump.
    // KILL CRITERION: if rendering stops, dolphin's per-iter servicing (MMIO
    // mirrors / mailbox drain, i.e. dolphin_service_iter) was load-bearing here —
    // export that and call it instead of skipping outright.
    // ?nopumpskip=1 restores the old behaviour for an A/B.
    // BOTH alternatives to the plain pump were MEASURED and are worse — do not
    // re-try either without new evidence:
    //   skip the pump entirely while recomp is live -> STALLS BOOT (renders the
    //     Nintendo logo, then one video_cb and no further presents; the per-iter
    //     MMIO-mirror / mailbox servicing is load-bearing for the recomp path).
    //   service-only (_dolphin_service_iter_js, exported for the attempt) ->
    //     boots and renders, but capped fps 48.1/47.7 against a 50.4 baseline.
    // The premise was that dolphin's own emulation competes with the FIFO decode
    // on this thread. It does not pay: the recomp worker produces ~16 frames per
    // rendered frame uncapped (skipped=112293), so the renderer is the limiter
    // and the pump is not what is holding it back.
    for (var i = 0; i < PUMP_BATCH_ITERS; i++) Module._run_iter_batch(1);
    // [recomp-bridge] armed fixture: apply once (RAM image + f32-array swaps + fifo upload),
    // then re-render each pump until the pump budget runs out.
    if (__recompFix && Module._recomp_render_fifo && __recompFixPumps > 0) {
      if (!__recompFixApplied) recompFixApply();
      var dN0 = Module.HEAPU32[0x026B289C >> 2] >>> 0;   // prim-draws-decoded SAB counter
      Module._recomp_render_fifo(__recompFixPtr, __recompFixLen);
      var dN1 = Module.HEAPU32[0x026B289C >> 2] >>> 0;
      // explicit present: the parked CPU means VI never fires OutputField; show the XFB our
      // stream's (patched) EFB copies just wrote.
      if (Module._recomp_present && __recompXfbAddr) Module._recomp_present(__recompXfbAddr, 640, 480);
      if ((__recompFixPumps % 200) === 0)
        postMessage({ cmd: 'print', txt: '[recompFix] pump ' + __recompFixPumps + ': draws/frame=' + (dN1 - dN0) });
      __recompFixPumps--;
    }
    // [recomp-seam] To visibly demo the recomp GP-FIFO -> Dolphin WGPU renderer seam,
    // set self.__RECOMP_DEMO = 1 (default OFF, prod-safe — leaves MP4 untouched). When on,
    // after boot it draws one colored triangle through _recomp_render_fifo every pump
    // (composites over MP4's frame; MP4's own state re-uploads each of its draws).
    if (self.__RECOMP_DEMO && Module._recomp_render_fifo) {
      __recompFrame++;
      if (__recompFrame > 400) {
        if (!__recompPtr) {
          __recompBytes = buildRecompTriangleFifo();
          __recompPtr = Module._malloc(__recompBytes.length);
          Module.HEAPU8.set(__recompBytes, __recompPtr);
        }
        Module._recomp_render_fifo(__recompPtr, __recompBytes.length);
      }
    }
  } else if (Module && Module._run_iter) {
    for (var j = 0; j < PUMP_BATCH_ITERS; j++) Module._run_iter();
  }
  // Three samples then permanently inert; see its definition. Called here rather than inside
  // the _run_iter arm because _run_iter_batch is the arm the live build actually takes, and
  // the census must sample the JIT path — which is the whole point of it existing.
  emitVtxCensusJit();
}

async function bootLoop() {
  if (bootLoopRunning) return;
  bootLoopRunning = true;
  // [tick-diag stripped 2026-08-05 per gate #8] the per-batch postMessage('print')
  // + page console.log (and 2 performance.now()/batch) ran the WHOLE session (the
  // "boot batch 1.3M" spam) — a real drain with DevTools open. Bare pump+yield now.
  while (!firstFrameSeen) {
    pumpBatch();
    __bootBatches++;
    await new Promise(function (r) { zeroYield(r); });
  }
  bootLoopRunning = false;
  startTickLoop();
}

// [PM54 zero-yield 2026-08-04] setTimeout(0) is CLAMPED by Chrome to ~4ms+
// after a few nested turns — measured turnAvg=4.8ms on the user's machine
// ([tick-diag]): every pump turn (PUMP_BATCH_ITERS quanta) paid ~4.8ms of
// DEAD SLEEP, capping the pump to ~200 turns/s regardless of emulator speed.
// A MessageChannel self-post yields the event loop (messages/mailbox/WGPU map
// callbacks all still deliver — it is a real macrotask turn) with ~0.03ms
// latency and NO clamp.
var _yieldChan = null, _yieldQueue = [];
function _zeroYieldRaw(cb) {
  if (!_yieldChan) {
    _yieldChan = new MessageChannel();
    _yieldChan.port1.onmessage = function () {
      var f = _yieldQueue.shift();
      if (f) f();
    };
  }
  _yieldQueue.push(cb);
  _yieldChan.port2.postMessage(0);
}
// HYBRID: a pure MessageChannel loop floods the message task source and
// STARVES the timer source — Dawn device ticks / readback completions are
// timer-scheduled, so presents froze after frame 1 (measured: gc +17% but
// zero recurring paints). Take the unclamped yield normally, but drop to a
// real setTimeout(0) periodically so timer tasks get a slot.
// [PM54e 2026-08-04] interval 4 -> 16ms: at 4ms, any pump turn taking >=4ms
// of WORK routed EVERY yield through the clamped setTimeout (~4.8ms dead
// sleep per turn — the user's steady-state console showed turnAvg=4.8ms
// return exactly when the emulator was busiest, halving the pump). Timer
// tasks only need ~60Hz service; 16ms keeps Dawn ticking at frame rate
// while heavy turns stay on the unclamped path.
var _lastTimerYield = 0;
function zeroYield(cb) {
  var now = performance.now();
  if (now - _lastTimerYield >= 16) {
    _lastTimerYield = now;
    setTimeout(cb, 0);
  } else {
    _zeroYieldRaw(cb);
  }
}

function startTickLoop() {
  if (tickInterval) return;
  // Zero-clamp yield chain, not setInterval(16): while we're below native
  // speed there is no idle budget to give back — run flat-out, yielding
  // each turn so input/mailbox messages keep flowing.
  var pump = function () {
    pumpBatch();
    __ticks++;
    zeroYield(pump);   // [tick-diag stripped 2026-08-05 per gate #8]
  };
  tickInterval = 1;   // marker: loop armed (no timer id under zeroYield)
  zeroYield(pump);
}

// [vtx-census JIT PATH 2026-08-28] The census above lives inside the RECOMP frame
// handler and is gated on __recompLiveFrames, so it has ONLY ever sampled ?recomp=1
// — i.e. Mario Party 4's native C port. The wasm vertex loader's supported-format
// list was specified entirely from that data ("top four = 97.6%"), and then the
// compare gate reported vtxCmp=0 on PSO: the loader never engaged, because PSO's
// formats are not MP4's. Every game other than MP4 runs the JIT path, which is what
// the user actually plays. This emits the same table there so the emitter can be
// aimed at real data. Three samples then it stops forever, so it cannot accumulate
// into a perf measurement.
var __vtxJitPumps = 0, __vtxJitPtr = 0, __vtxJitDone = 0;
function emitVtxCensusJit() {
  if (__vtxJitDone >= 3 || !Module._bem_vtx_census) return;
  __vtxJitPumps++;
  if (__vtxJitPumps !== 600 && __vtxJitPumps !== 1800 && __vtxJitPumps !== 3600) return;
  __vtxJitDone++;
  if (!__vtxJitPtr) __vtxJitPtr = Module._malloc(256 * 6 * 4);
  var n = Module._bem_vtx_census(__vtxJitPtr, 256);
  var rows = [], tot = 0;
  for (var i = 0; i < n; i++) {
    var b = (__vtxJitPtr >> 2) + i * 6, c = Module.HEAPU32[b + 5] >>> 0;
    rows.push([[Module.HEAPU32[b] >>> 0, Module.HEAPU32[b + 1] >>> 0, Module.HEAPU32[b + 2] >>> 0,
                Module.HEAPU32[b + 3] >>> 0, Module.HEAPU32[b + 4] >>> 0], c]);
    tot += c;
  }
  rows.sort(function (a, b) { return b[1] - a[1]; });
  var top = rows.slice(0, 6).map(function (r) {
    return 'desc=' + r[0][0].toString(16) + '/' + r[0][1].toString(16) +
           ' vat=' + r[0][2].toString(16) + '/' + r[0][3].toString(16) + '/' + r[0][4].toString(16) +
           ' ' + (tot ? (100 * r[1] / tot).toFixed(1) : '0') + '%';
  }).join('  |  ');
  postMessage({ cmd: 'print', txt: '[vtxcensus-jit] sample=' + __vtxJitDone + ' loaders=' + n +
                                   ' verts=' + tot + ' top=' + top });
}

// Called once we know rendering has begun (set by video_cb in
// EmscriptenWorker.cpp). Lets bootLoop fall through to the 60 Hz tick.
function markFirstFrame() {
  if (firstFrameSeen) return;
  firstFrameSeen = true;
  startTickLoop();
}

async function bootIso(name, size) {
  if (bootStarted) return;
  bootStarted = true;
  var total = new Uint8Array(size);
  var off = 0;
  for (var i = 0; i < romChunks.length; i++) {
    var c = romChunks[i];
    total.set(c, off);
    off += c.byteLength;
  }
  romChunks = null;
  try {
    Module.FS.writeFile('/' + name, total);
  } catch (e) {
    postMessage({ cmd: 'print', txt: '[worker] FS.writeFile failed: ' + e });
    return;
  }
  total = null;
  // Force MMU emulation on via Dolphin.ini in MEMFS. Without translation, the
  // WASM JIT trampolines pass raw guest virtual addresses to the memory system,
  // panicking on cached-RAM mirror addresses (0x8xxxxxxx). DolphinLibretro/Boot.cpp
  // also forces MAIN_MMU=true under __EMSCRIPTEN__, so this is belt-and-braces.
  // SkipIPL=False makes Dolphin run the bundled IPL (BS2) before handing control
  // to the disc — without that the boot path leaves hardware uninitialized
  // and the game stalls at 0x80003140 with MSR interrupts disabled.
  try {
    var iniDir = '/home/web_user/retroarch/userdata/system/dolphin-emu/User/Config';
    Module.FS.mkdirTree(iniDir);
    // GFXBackend must be in the ini: the boot-time load of this file resets
    // the base config layer, so this key is the AUTHORITATIVE backend choice.
    // [HW-render 2026-06-17] "OGL" = Dolphin's OpenGL backend, which under emcc
    // routes GLES3 -> WebGL2 (libvideoogl.a linked; SET_HW_RENDER answered in
    // EmscriptenWorker.cpp; context on the transferred OffscreenCanvas). This
    // rasterizes on the GPU instead of the CPU-thread Software Renderer.
    // [HW-render path-b] CPUThread = True enables Dolphin dual-core: the video
    // backend (OGL) runs on a separate GPU thread spawned via real
    // pthread_create, which CAN own the OffscreenCanvas (unlike the
    // _emscripten_proxy_main main thread). GLContextLR::Initialize then runs on
    // that GPU thread, where the WebGL2 context is created locally.
    // [HW-render 2026-06-17] CPUThread (dual-core) was TESTED and did NOT fix the
    // post-frame-4 wedge (identical stall: guest spins at 0x806c7f44, OutputXFB
    // stops at n=4) — so the wedge is not CPU/GPU-thread present blocking. Reverted
    // to single-core to keep the working HW-render baseline clean (gate #8).
    // [render-opt 2026-06-19] CPUThread=True (off-thread present) RE-TESTED post-
    // getParameter-fix: now WEDGE-SAFE (frames advance to n=256), BUT does NOT
    // offload the render — under OffscreenCanvas + proxyContextToMainThread the GL
    // context is pinned to worker_0, so the GPU pthread's GL calls just proxy back
    // (worker_0 texSubImage3D rose to 37%). And guest progress was identical
    // (ticks 2336.33M), confirming the boot is CoreTiming-pacing/dispatch bound,
    // not render-bound. Reverted to single-core (no offload benefit + dual-core risk).
    // [WGPU] When the page set the WGPU shared-heap flag (0x07FF0100 = 'WGPU'), make the
    // .ini's AUTHORITATIVE backend WGPU so Dolphin activates the WGPU backend, not OGL
    // (which has no HW context here and falls back to the Software renderer).
    var _wgpu = false;
    try {
      var _h = Module.HEAPU32 || new Uint32Array(Module.HEAPU8.buffer);
      _wgpu = (_h[0x07FF0100 >> 2] === 0x57475055);
    } catch (e) {}
    var _gfxBackend = _wgpu ? 'WGPU' : 'OGL';
    var iniBody = '[Core]\nMMU = True\nSkipIPL = False\nGFXBackend = ' + _gfxBackend + '\n';
    Module.FS.writeFile(iniDir + '/Dolphin.ini', iniBody);
    postMessage({ cmd: 'print', txt: '[worker] wrote Dolphin.ini (MMU=True, SkipIPL=False, GFXBackend=' + _gfxBackend + ') at ' + iniDir });
    try {
      var cfg = Module.FS.readFile(iniDir + '/Dolphin.ini', { encoding: 'utf8' });
      postMessage({ cmd: 'print', txt: '[config] Dolphin.ini: ' + cfg.replace(/\n/g, ' \\n ') });
    } catch (re) {
      postMessage({ cmd: 'print', txt: '[worker] Dolphin.ini readback failed: ' + re });
    }
  } catch (e) {
    postMessage({ cmd: 'print', txt: '[worker] Dolphin.ini write failed: ' + e });
  }

  // Stage IPL.bin into every path Dolphin's BS2 loader might check. The
  // emscripten runtime doesn't have a libretro SetUserPath override, so the
  // resolved D_GCUSER_IDX / GetSysDirectory() values aren't grep-able — write
  // to all plausible roots, GetBootROMPath() returns the first hit it finds.
  // Region is GC/USA for SA2B (GSNE8P, NTSC-U); add EUR / JAP if other discs
  // get added later.
  try {
    var iplResp = await fetch('/gamecube/IPL.bin');
    if (!iplResp.ok) {
      postMessage({ cmd: 'print', txt: '[ipl] fetch failed: HTTP ' + iplResp.status });
    } else {
      var iplBuf = await iplResp.arrayBuffer();
      var iplBytes = new Uint8Array(iplBuf);
      // Cover every plausible <UserPath>/GC/USA and <SysDir>/GC/USA combo.
      var iplDirs = [
        '/home/web_user/retroarch/userdata/system/dolphin-emu/User/GC/USA',
        '/home/web_user/.dolphin-emu/GC/USA',
        '/home/web_user/dolphin-emu/User/GC/USA',
        '/dolphin-emu/User/GC/USA',
        '/dolphin-emu/Sys/GC/USA',
        '/User/GC/USA',
        '/Sys/GC/USA',
        '/GC/USA',
      ];
      var written = 0;
      for (var di = 0; di < iplDirs.length; di++) {
        try {
          Module.FS.mkdirTree(iplDirs[di]);
          Module.FS.writeFile(iplDirs[di] + '/IPL.bin', iplBytes);
          written++;
        } catch (we) {
          postMessage({ cmd: 'print', txt: '[ipl] write to ' + iplDirs[di] + ' failed: ' + we });
        }
      }
      postMessage({ cmd: 'print', txt: '[ipl] wrote IPL.bin ' + iplBuf.byteLength + ' bytes to ' + written + '/' + iplDirs.length + ' candidate paths' });
    }
  } catch (e) {
    postMessage({ cmd: 'print', txt: '[ipl] write threw: ' + e });
  }

  // Stage the GSNE8P (SAB) symbol map into User/Maps so PPCSymbolDB's
  // LoadMapOnBoot finds it and HLE::PatchFunctions can install the
  // ___blank / OSReport hooks for DBPrintf, etc. Without this, native's
  // DBPrintf-no-op patch isn't installed and the real body's
  // OSThread-scheduler polls wedge boot at pc=0x800ecb48. Source file
  // tools/gsne8p.map is lowercase on disk; Dolphin's FindMapFile uses
  // m_debugger_game_id which is uppercase "GSNE8P".
  try {
    // tools/gsne8p.map is a 16690-byte partial map with 258 symbols and a
    // different header format ("Starting / Virtual / File / address") that
    // Dolphin's PPCSymbolDB doesn't parse. The full 226627-byte map at
    // dolphin_captures/sab.map (5097 symbols) is byte-identical to native's
    // ~/Library/Application Support/Dolphin/Maps/GSNE8P.map (verified by
    // MD5). Without the full map, only ~258 symbols load → HLE patches for
    // OSReport/___blank/OSPanic that depend on symbol-DB lookup don't all
    // install → wasm runs real OSPanic body on faults → reaches PPCHalt.
    var mapResp = await fetch('/dolphin_captures/sab.map');
    if (!mapResp.ok) {
      postMessage({ cmd: 'print', txt: '[map] fetch failed: HTTP ' + mapResp.status });
    } else {
      var mapBuf = await mapResp.arrayBuffer();
      var mapBytes = new Uint8Array(mapBuf);
      // Dolphin's UserPath resolves to "//User/Maps/" — environment_cb in
      // EmscriptenWorker.cpp returns "/" for SAVE_DIRECTORY, and Boot.cpp
      // computes user_dir = save_dir + "/User" = "//User", then SetUserPath
      // appends "/" → "//User/" → D_MAPS_IDX = "//User/Maps/". MEMFS should
      // normalize the double slash but verify by writing to every plausible
      // path. The old RetroArch path (.../retroarch/...) was never checked.
      // Without this HLE patches for OSReport/___blank/OSPanic don't
      // install → wasm runs real OSPanic body → PPCHalt wedge.
      var mapDirs = [
        '/User/Maps',
        '/home/web_user/.dolphin-emu/Maps',
        '/home/web_user/dolphin-emu/User/Maps',
        '/dolphin-emu/User/Maps',
        '/dolphin-emu/Maps',
        '/Maps',
      ];
      var mapWritten = 0;
      for (var mi = 0; mi < mapDirs.length; mi++) {
        try {
          Module.FS.mkdirTree(mapDirs[mi]);
          Module.FS.writeFile(mapDirs[mi] + '/GSNE8P.map', mapBytes);
          mapWritten++;
        } catch (we) {
          postMessage({ cmd: 'print', txt: '[map] write to ' + mapDirs[mi] + ' failed: ' + we });
        }
      }
      postMessage({ cmd: 'print', txt: '[map] wrote GSNE8P.map ' + mapBuf.byteLength + ' bytes to ' + mapWritten + '/' + mapDirs.length + ' candidate paths' });
    }
  } catch (e) {
    postMessage({ cmd: 'print', txt: '[map] write threw: ' + e });
  }

  postMessage({ cmd: 'print', txt: '[worker] ISO written to /' + name + ' (' + size + ' bytes), calling load_iso' });
  // load_iso is ASYNCIFY-async under WGPU (WGPUGfx creates its device via an emscripten_sleep
  // event-loop pump), so a plain ccall returns a Promise — `ret` would be a Promise, trip the
  // !== 0 check, and bootLoop would never run. Use {async:true} + .then (works for the sync SW
  // path too — there the Promise just resolves immediately with the real return value).
  if (!Module._load_iso) {
    postMessage({ cmd: 'setStatus', txt: 'load_iso failed (no _load_iso)' });
    return;
  }
  Module.ccall('load_iso', 'number', ['string'], ['/' + name], { async: true }).then(function (ret) {
    if (ret !== 0) {
      postMessage({ cmd: 'print', txt: '[worker] load_iso returned ' + ret });
      postMessage({ cmd: 'setStatus', txt: 'load_iso failed (' + ret + ')' });
      return;
    }
    // Phase A1: cls-table init runs on the dolphin pthread inside HW::Init (HW.cpp routes
    // through dolphin_mmio_mirror_init C-extern to defeat LTO DCE). Don't call it from JS —
    // under PROXY_TO_PTHREAD the JS-thread call would land in main-thread memory.
    postMessage({ cmd: 'setStatus', txt: 'Running' });
    bootLoop();  // run flat-out during boot; switch to 60 Hz once first frame fires
  });
}

self.onmessage = function (e) {
  var data = e.data || {};
  // [mailbox-diag 2026-06-12] temporary: pin why page->worker requests
  // (get-ram-info) never reach this switch in live runs (ramInfoSeen=0 on
  // BOTH MP4 and PSO dumps while print/audio replies flow). Logs every
  // non-romChunk command arrival. Strip with the other diags per gate #8.
  switch (data.cmd) {
    case 'romChunk':
      if (data.buf && data.buf.byteLength) {
        romChunks.push(new Uint8Array(data.buf));
        totalSize += data.buf.byteLength;
      }
      break;
    case 'romEnd':
      if (Module && Module.calledRun) {
        bootIso(data.name, data.size);
      } else {
        var prev = Module && Module.onRuntimeInitialized;
        if (!Module) Module = {};
        Module.onRuntimeInitialized = function () {
          if (prev) try { prev(); } catch (_) {}
          bootIso(data.name, data.size);
        };
      }
      break;
    case 'input':
      if (Module && Module.calledRun && Module.HEAPU8 && Module._get_pad_ptr) {
        var ptr = Module._get_pad_ptr();
        if (data.states && data.states.length) {
          Module.HEAPU8.set(data.states, ptr);
        }
      }
      break;
    case 'saveState':
      // [savestate-deadlock-fix PM61] do NOT call _state_size/_save_state here —
      // they use RunOnCPUThread(wait) and BLOCK this (message/pump) thread, which
      // the dual-core EmuThread needs → deadlock. Flag a request; the JIT dispatch
      // loop services it ON the CPU thread; poll async so the pump keeps running.
      (async function () {
        if (!Module || !Module.calledRun) { postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) }); return; }
        try {
          var cap = 96 * 1024 * 1024;   // GC state ~56MB; generous headroom
          if (Module._bem_save_request(cap) !== 0) { postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) }); return; }
          var len = -1, tries = 0;
          while (len < 0 && tries < 4000) {
            await new Promise(function (r) { setTimeout(r, 5); });
            len = Module._bem_state_poll();
            tries++;
          }
          if (len > 0) {
            var ptr = Module._bem_state_buf_ptr();
            var buf = new Uint8Array(Module.HEAPU8.subarray(ptr, ptr + len));
            postMessage({ cmd: 'stateSaved', data: buf });
          } else {
            postMessage({ cmd: 'print', txt: '[worker] saveState: len=' + len + ' (timeout or too big)' });
            postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) });
          }
          Module._bem_state_release();
        } catch (e) {
          postMessage({ cmd: 'print', txt: '[worker] saveState failed: ' + e });
          postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) });
        }
      })();
      break;
    case 'loadState':
      // [savestate-deadlock-fix PM61] same CPU-thread routing as saveState:
      // alloc + fill the buffer, commit, then the JIT loop runs load_state inline.
      (async function () {
        if (!Module || !Module.calledRun) { postMessage({ cmd: 'stateLoaded' }); return; }
        try {
          var src = data.data || new Uint8Array(0);
          if (Module._bem_load_request(src.length) !== 0) { postMessage({ cmd: 'stateLoaded' }); return; }
          Module.HEAPU8.set(src, Module._bem_state_buf_ptr());
          Module._bem_load_commit();   // sets op=2 AFTER the buffer is filled
          var done = -1, tries = 0;
          while (done < 0 && tries < 4000) {
            await new Promise(function (r) { setTimeout(r, 5); });
            done = Module._bem_state_poll();
            tries++;
          }
          Module._bem_state_release();
          postMessage({ cmd: 'stateLoaded' });
        } catch (e) {
          postMessage({ cmd: 'print', txt: '[worker] loadState failed: ' + e });
          postMessage({ cmd: 'stateLoaded' });
        }
      })();
      break;
    case 'setup-ppc-mailbox':
      // 4f-6 reframe: dolphin no longer polls the SAB mailbox itself
      // (its private wasm memory can't observe page-side req_ready
      // writes). The 4f-6 page-mediated routing replaces that role —
      // page polls the SAB and forwards real MMIO cmds via 'mbx-cmd'
      // postMessage. The C-side dolphin_ppc_mailbox_init/poll remain
      // defined for binary-compat, but the init call is now a no-op
      // signal: we just print so the cascade log lines up.
      postMessage({ cmd: 'print', txt: '[worker] setup-ppc-mailbox legacy ack (4f-6: routing is page-mediated)' });
      break;
    case 'ct-phase-set':
      // Item 7 Phase IV: page-driven gate. Called by gamecube.html when
      // ppc-worker is taking over PPC dispatch (?ppcbootdispatch=1). Bits
      // match gamecube/ppc-worker/sab_layout.h:386 (PHASE4=0x2, PHASE5=0x4).
      if (Module && Module._dolphin_ct_set_phase_flags) {
        var flags = (data.flags | 0) >>> 0;
        Module._dolphin_ct_set_phase_flags(flags);
        postMessage({ cmd: 'print',
          txt: '[worker] ct-phase-set flags=0x' + flags.toString(16) });
      } else {
        postMessage({ cmd: 'print',
          txt: '[worker] ct-phase-set: Module._dolphin_ct_set_phase_flags missing' });
      }
      break;
    // [recomp-bridge 2026-08-25] Render a decomp->wasm recomp frame through the live WGPU
    // backend. e.data: { fifo: ArrayBuffer (BE GP-FIFO), mem1: ArrayBuffer|null (raw 24MB
    // guest image), regions: {arrays:[{base,stride,count}],dls:[...]}|null, pauseCpu: bool,
    // pumps: how many pump cycles to re-render (state re-upload each pump) }.
    // With mem1: the image is written into Dolphin's emulated RAM (dolphin_get_ram_addr) and
    // the f32-based arrays (stride 8/12) are byte-swapped LE->BE in place — Dolphin's vertex
    // loader reads guest arrays big-endian, while the recomp's linear memory is little-endian.
    // pauseCpu skips _run_iter_batch from then on (the JIT game stops advancing; only safe
    // combined with mem1 overwrite, which destroys the running guest).
    case 'recompFix': {
      __recompFix = e.data;
      __recompFixApplied = false;
      __recompFixPumps = e.data.pumps || 600;
      postMessage({ cmd: 'recompFix-armed' });
      break;
    }
    // [recomp-live 2026-08-25] Live recomp stream: 'recompStart' parks the JIT CPU and
    // latches the VI scanout target; each 'recompFrame' writes the frame's new RAM regions
    // (pre-swapped by recomp_worker.js), retargets the display copy, renders through
    // recomp_render_fifo, and presents. Counters exposed via 'recompStats' polls.
    case 'recompStart': {
      if (Module._recomp_pause_cpu) Module._recomp_pause_cpu();
      var t2 = 0;
      try { t2 = Module._dolphin_read32(0xCC00201C) >>> 0; } catch (er) {}
      __recompLiveXfb = t2 & 0x00FFFFFF;
      if (t2 & 0x10000000) __recompLiveXfb = (__recompLiveXfb << 5) >>> 0;
      __recompLive = true;
      postMessage({ cmd: 'print', txt: '[recompLive] started; xfb=0x' + __recompLiveXfb.toString(16) });
      break;
    }
    case 'recompFrame': {
      if (!__recompLive || !Module || !Module._recomp_render_fifo) break;
      var tA = performance.now();
      var ram2 = Module._dolphin_get_ram_addr();
      if (e.data.mem1) Module.HEAPU8.set(new Uint8Array(e.data.mem1), ram2);   // one-time full image
      var regs2 = e.data.regions || [];
      var regBytes2 = 0;
      for (var ri = 0; ri < regs2.length; ri++) {
        var R2 = regs2[ri];
        if (R2.addr + R2.bytes.byteLength <= 0x01800000) {
          Module.HEAPU8.set(new Uint8Array(R2.bytes), ram2 + R2.addr);
          regBytes2 += R2.bytes.byteLength;
        }
      }
      if (e.data.skipRender) { __recompT.skip++; break; }   // backlogged: state applied, draw skipped
      var fb2 = new Uint8Array(e.data.fifo);
      // Present the recomp's OWN display-copy dest (last 0x4B value in the stream). The old
      // retarget-to-JIT-XFB made the 614KB XFB write land inside the recomp guest's live heap
      // (at the board: 0x1e6c00..0x27cc00, overwriting the window font at 0x25c220 every frame
      // = the "barcode text"). recomp_present takes an explicit address — no retarget needed.
      {
        var lv2 = 0;
        for (var p2 = 0; p2 + 4 < fb2.length; p2++)
          if (fb2[p2] === 0x61 && fb2[p2 + 1] === 0x4B)
            lv2 = (fb2[p2 + 2] << 16) | (fb2[p2 + 3] << 8) | fb2[p2 + 4];
        if (lv2) __recompLiveXfb = (lv2 << 5) >>> 0;
      }
      if (!__recompLivePtr || __recompLiveCap < fb2.length) {
        if (__recompLivePtr) Module._free(__recompLivePtr);
        __recompLiveCap = fb2.length + 65536;
        __recompLivePtr = Module._malloc(__recompLiveCap);
      }
      Module.HEAPU8.set(fb2, __recompLivePtr);
      var tB = performance.now();
      var dq0 = Module.HEAPU32[0x026B289C >> 2] >>> 0;
      Module._recomp_render_fifo(__recompLivePtr, fb2.length);
      var dq1 = Module.HEAPU32[0x026B289C >> 2] >>> 0;
      var tC = performance.now();
      if (Module._recomp_present && __recompLiveXfb) Module._recomp_present(__recompLiveXfb, 640, 480);
      var tD = performance.now();
      __recompT.prep += tB - tA; __recompT.fifo += tC - tB; __recompT.present += tD - tC;
      __recompT.n++; __recompT.regB += regBytes2; __recompT.fifoB += fb2.length;
      __recompLiveFrames++;
      postMessage({ cmd: 'recompAck', n: e.data.n });
      // [vtx-census 2026-08-28] Rank vertex-loader formats by vertices actually
      // loaded. Under emscripten the SOFTWARE VertexLoader is used (no
      // VertexLoaderX64/ARM64), and its per-vertex indirect-call pipeline is
      // ~43% of this worker — so a wasm loader has to target whichever formats
      // dominate. Cheap: runs once per 240 rendered frames.
      if ((__recompLiveFrames % 240) === 1 && Module._bem_vtx_census) {
        if (!__vtxCensusPtr) __vtxCensusPtr = Module._malloc(256 * 6 * 4);
        var _vn = Module._bem_vtx_census(__vtxCensusPtr, 256);
        var _rows = [], _tot = 0;
        for (var _i = 0; _i < _vn; _i++) {
          var _b = (__vtxCensusPtr >> 2) + _i * 6;
          var _d = [Module.HEAPU32[_b] >>> 0, Module.HEAPU32[_b + 1] >>> 0, Module.HEAPU32[_b + 2] >>> 0,
                    Module.HEAPU32[_b + 3] >>> 0, Module.HEAPU32[_b + 4] >>> 0];
          var _c = Module.HEAPU32[_b + 5] >>> 0;
          _rows.push([_d, _c]); _tot += _c;
        }
        _rows.sort(function (a, b) { return b[1] - a[1]; });
        var _top = _rows.slice(0, 4).map(function (r) {
          return 'desc=' + r[0][0].toString(16) + '/' + r[0][1].toString(16) +
                 ' vat=' + r[0][2].toString(16) + '/' + r[0][3].toString(16) + '/' + r[0][4].toString(16) +
                 ' ' + (_tot ? (100 * r[1] / _tot).toFixed(1) : '0') + '%';
        }).join('  |  ');
        postMessage({ cmd: 'print', txt: '[vtxcensus] loaders=' + _vn + ' verts=' + _tot + ' top=' + _top });
      }
      if ((__recompLiveFrames % 240) === 1) {
        var _n = Math.max(1, __recompT.n);
        postMessage({ cmd: 'print', txt: '[recompLive] f' + __recompLiveFrames + ' fifo=' + fb2.length
          + 'B draws=' + (dq1 - dq0) + ' regions=' + regs2.length
          + ' | ms/f prep=' + (__recompT.prep / _n).toFixed(2) + ' fifo=' + (__recompT.fifo / _n).toFixed(2)
          + ' present=' + (__recompT.present / _n).toFixed(2) + ' | regKB/f=' + (__recompT.regB / _n / 1024).toFixed(1)
          + ' fifoKB/f=' + (__recompT.fifoB / _n / 1024).toFixed(1) + ' skipped=' + __recompT.skip });
        __recompT = { prep: 0, fifo: 0, present: 0, n: 0, regB: 0, fifoB: 0, skip: __recompT.skip };
      }
      break;
    }
    case 'recompStats': {
      postMessage({ cmd: 'recompStats', frames: __recompLiveFrames });
      break;
    }
    // debug: sample the EFB on a grid — did draws leave fragments, independent of XFB/present
    case 'recompEfbPeek': {
      var grid = [];
      try {
        for (var gy = 40; gy < 480; gy += 80) {
          var row = [];
          for (var gx = 40; gx < 640; gx += 80) row.push((Module._recomp_efb_peek(gx, gy) >>> 0).toString(16).padStart(8, '0'));
          grid.push('y' + gy + ': ' + row.join(' '));
        }
      } catch (er) { grid = ['ERR ' + er]; }
      // counter deltas across ONE synchronous frame render: decoder-level draws (0x026B289C)
      // vs real GPU DrawCurrentBatch submissions (0x026B352C)
      try {
        if (__recompFix && Module._recomp_render_fifo && __recompFixPtr) {
          var c0 = Module.HEAPU32[0x026B289C >> 2] >>> 0, g0 = Module.HEAPU32[0x026B352C >> 2] >>> 0;
          Module._recomp_render_fifo(__recompFixPtr, __recompFixLen);
          var c1 = Module.HEAPU32[0x026B289C >> 2] >>> 0, g1 = Module.HEAPU32[0x026B352C >> 2] >>> 0;
          grid.push('one-frame: decoderDraws=' + (c1 - c0) + ' gpuSubmits=' + (g1 - g0));
        }
      } catch (er2) { grid.push('CNT-ERR ' + er2); }
      postMessage({ cmd: 'print', txt: '[recompEfbPeek] ' + grid[grid.length - 1] });
      postMessage({ cmd: 'print', txt: '[recompEfbPeek] ' + grid.slice(0, 3).join(' | ') });
      break;
    }
    // debug: dump a window of Dolphin-side emulated RAM as hex (diff against the
    // recomp guest's intent when chasing live-sync corruption)
    case 'recompPeek': {
      var pk = '';
      try {
        var ramP = Module._dolphin_get_ram_addr() + (e.data.addr >>> 0);
        for (var pi = 0; pi < (e.data.len >>> 0); pi++) pk += Module.HEAPU8[ramP + pi].toString(16).padStart(2, '0');
      } catch (er) { pk = 'ERR ' + er; }
      postMessage({ cmd: 'recompPeek', addr: e.data.addr, hex: pk });
      break;
    }
    case 'pause-for-cutover':
    case 'resume-from-cutover':
      // 2d.9 reverted — see memory:2d9_real_cutover_blocked.md.
      // Acknowledge to keep the page's cascade unstuck if it sent
      // the message anyway.
      postMessage({ cmd: 'cutover-resumed', error: '2d.9 cutover blocked by PROXY_TO_PTHREAD memory isolation' });
      break;
    case 'state-export-test': {
      // 2d.7: stamp the dolphin-side test PowerPCState buffer with a
      // known sentinel + pattern, then ship the buffer bytes to the
      // page via Transferable. Page copies into SAB[0x02400000] and
      // verifies the layout (PC at +0, pattern at +4..). Production
      // PowerPCState mirror will work the same way but read from
      // m_system.GetPPCState() instead of the test buffer.
      try {
        var pcSentinel = (data.pcSentinel | 0) >>> 0;
        Module._dolphin_test_state_set_pc(pcSentinel);
        var addr = Module._dolphin_test_state_buf_addr() >>> 0;
        var size = Module._dolphin_test_state_buf_size() >>> 0;
        var bytes = new Uint8Array(size);
        bytes.set(Module.HEAPU8.subarray(addr, addr + size));
        postMessage({ cmd: 'state-export-test-result', size: size, pcSentinel: pcSentinel, bytes: bytes.buffer }, [bytes.buffer]);
      } catch (err) {
        postMessage({ cmd: 'state-export-test-result', error: 'state-export-test threw: ' + (err && err.message ? err.message : String(err)) });
      }
      break;
    }
    case 'get-ram-info': {
      // 2g: page polls this until non-zero, then forwards to ppc-worker
      // so its self-compile path can read instructions directly from
      // SAB-mapped guest RAM. Returns 0/0 until JitWasm::Init() runs.
      try {
        var addr = (typeof Module._dolphin_get_ram_addr === 'function')
          ? (Module._dolphin_get_ram_addr() >>> 0) : 0;
        var size = (typeof Module._dolphin_get_ram_size === 'function')
          ? (Module._dolphin_get_ram_size() >>> 0) : 0;
        postMessage({ cmd: 'ram-info', addr: addr, size: size });
      } catch (err) {
        postMessage({ cmd: 'ram-info', addr: 0, size: 0, error: String(err && err.message || err) });
      }
      break;
    }
    case 'compile-test': {
      // 2d.2: page asks dolphin to emit a real bementalJIT wasm module
      // for `pc` and ship the bytes back. dolphin_test_compile_block
      // calls bemental::powerpc::build_block for a synthetic 1-nop
      // sequence; bytes live in g_test_compile_buf (in dolphin's heap).
      // We read via Module.HEAPU8 and Transferable-postMessage to page.
      try {
        var pc = (data.pc | 0) >>> 0;
        var tag = data.tag || 'verify';
        var nInsts = (data.nInsts | 0) >>> 0;  // 0 = default 1
        // 2d.6: when realDecode is set, try the post-boot real-decode
        // path first (uses dolphin's MMU to read instructions from
        // emulated RAM at pc). Returns 0 pre-boot or on decode failure;
        // fall through to the synth path so verification still gets
        // valid bytes back.
        var size = 0;
        var decoded = false;
        if (data.realDecode) {
          size = Module._dolphin_compile_block_real(pc) >>> 0;
          decoded = (size !== 0);
        }
        if (size === 0) {
          size = Module._dolphin_test_compile_block(pc, nInsts) >>> 0;
        }
        if (size === 0) {
          postMessage({ cmd: 'compile-test-result', tag: tag, error: 'build_block returned 0 bytes' });
          break;
        }
        var addr = Module._dolphin_test_compile_block_addr() >>> 0;
        // 2f.0: cycle count of this block (raw instruction count).
        // ppc-worker uses this to decrement ppc_state.downcount per
        // dispatch in the continuous run loop (2f.1).
        var cycles = (typeof Module._dolphin_get_last_compile_cycles === 'function')
          ? (Module._dolphin_get_last_compile_cycles() >>> 0) : 0;
        // Copy out of dolphin's heap into a fresh ArrayBuffer so the
        // Transferable transfer doesn't take the heap-backed view.
        var bytes = new Uint8Array(size);
        bytes.set(Module.HEAPU8.subarray(addr, addr + size));
        postMessage({ cmd: 'compile-test-result', tag: tag, pc: pc, size: size, decoded: decoded, cycles: cycles, bytes: bytes.buffer }, [bytes.buffer]);
      } catch (err) {
        postMessage({ cmd: 'compile-test-result', tag: data.tag || 'verify', error: 'compile-test threw: ' + (err && err.message ? err.message : String(err)) });
      }
      break;
    }
    case 'mbx-cmd': {
      // 4f-6: page polls the SAB mailbox; on real MMIO cmds (2..12)
      // it postMessages here. We call the proxied wasm export and
      // post the reply back. Page writes the reply into the SAB
      // mailbox slot. Round-trip cost ~1-2ms wall — acceptable for
      // verification cascades; a perf concern for hot MMIO paths
      // that's solved later by moving PowerPCState into shared SAB.
      //
      // Module.calledRun isn't reliable under PROXY_TO_PTHREAD (main
      // thread's flag may never set). Try/catch the proxied call so a
      // not-yet-initialised export becomes a 0 reply instead of an
      // unhandled exception that wedges the cascade.
      var c = data.mboxCmd >>> 0;
      var a0 = data.arg0 >>> 0;
      var a1 = data.arg1 >>> 0;
      var r = 0;
      try {
        switch (c) {
          case 2:  r = Module._dolphin_read8 (a0) >>> 0; break;
          case 3:  r = Module._dolphin_read16(a0) >>> 0; break;
          case 4:  r = Module._dolphin_read32(a0) >>> 0; break;
          case 5:  Module._dolphin_write8 (a0, a1); break;
          case 6:  Module._dolphin_write16(a0, a1); break;
          case 7:  Module._dolphin_write32(a0, a1); break;
          case 8:  r = Module._dolphin_hle_check(a0) >>> 0; break;
          case 9:  Module._dolphin_interp(a0, a1); break;
          case 10: r = Module._dolphin_check_exc(a0) >>> 0; break;
          case 11: Module._dolphin_break_block(a0); break;
          case 12: r = Module._dolphin_read_tb(a0) >>> 0; break;
          case 14: // Item 5 — HleFire (pc, idx|type<<16) -> next_pc
            r = Module._dolphin_hle_fire(a0, a1) >>> 0; break;
          case 100:
            // 4f-6 routing-live probe. Pure function (no emulator
            // state), so it works pre-boot. The cascade verifies the
            // round-trip: cmd 100 with arg0=0 must reply 0xCAFEBABE.
            r = Module._dolphin_routing_probe(a0) >>> 0;
            break;
          default: r = 0;
        }
      } catch (err) {
        postMessage({ cmd: 'print', txt: '[worker] mbx-cmd ' + c + ' threw: ' + (err && err.message ? err.message : String(err)) });
        r = 0;
      }
      postMessage({ cmd: 'mbx-reply', mboxCmd: c, reply: r });
      break;
    }
    default:
      postMessage({ cmd: 'print', txt: '[worker] unknown cmd: ' + data.cmd });
  }
};

postMessage({ cmd: 'print', txt: '[worker] post-js ready, waiting for runtime init' });

} // end !ENVIRONMENT_IS_PTHREAD guard
