// gamecube/dolphin_libretro/dolphin_worker.js — shim wrapper.
//
// 2e.3b: dolphin's wasm runs in this Worker, but the emscripten output
// (dolphin_worker_emcc.js) creates its OWN WebAssembly.Memory unless
// Module.wasmMemory is set BEFORE the bootstrapper runs. The page can't
// reach into the worker's Module from outside, so this shim:
//
//   1. Awaits a 'mem-init' postMessage carrying the page's shared
//      WebAssembly.Memory (the same SAB-backed memory ppc-worker uses).
//   2. Sets self.Module = { wasmMemory: that memory, locateFile: ... }.
//   3. importScripts('dolphin_worker_emcc.js'), which now imports the
//      shared memory instead of allocating its own.
//   4. Replays any messages the page sent before mem-init was processed.
//
// Pthread spawns: emcc spawns child pthread workers using THIS SAME
// script name (with self.name === 'em-pthread'). Those workers must NOT
// wait for mem-init — they receive their setup via emcc's pthread
// 'load' message protocol. Detect and importScripts immediately.
//
// With dolphin's link configured -sGLOBAL_BASE=0x10000000 (2e.3a) and
// ppc-worker's data at default low addresses, the two modules' static
// data sections don't overlap when both import the same SAB.
// PowerPCState region at SAB[0x02400000] sits in the gap between
// ppc-worker's data (small, low) and dolphin's data (starts at 256 MB) —
// safe from instantiation-time data-section copies on either side.

(function () {
  // Pthread workers spawned by emscripten load this same script, then
  // expect to receive a 'load' postMessage with pthread setup data.
  // Skip the mem-init wait in that case.
  if (typeof self !== 'undefined' && self.name === 'em-pthread') {
    // Bridge pthread-side stdout/stderr to the parent worker (which forwards
    // to page console). Dolphin's main thread runs in a pthread spawned here;
    // its LogManager fprintf(stderr, ...) writes go to this child's Module
    // printErr, NOT to the parent shim's printErr. Without this override,
    // every "Patching OSReport" / "symbols loaded" / OSREPORT print from
    // Dolphin's LogManager is silently dropped under PROXY_TO_PTHREAD.
    self.Module = self.Module || {};
    self.Module.print    = function (t) { postMessage({ cmd: 'print', txt: '[dolphin:stdout] ' + t }); };
    self.Module.printErr = function (t) { postMessage({ cmd: 'print', txt: '[dolphin:stderr] ' + t }); };
    // [cache-bust] The PROXY-main pthread (which runs the emulator main + the
    // video_cb present path) is an 'em-pthread' loaded HERE — without a buster it
    // reused a STALE cached emcc.js/.wasm, so new bridge code (e.g. the HW-render
    // changes) silently never ran on the thread that matters. Bust both.
    if (!self.Module.locateFile) {
      var _pv = Date.now();
      self.Module.locateFile = function (f) {
        var u = new URL(f, self.location.href).href;
        return /\.wasm($|\?)/.test(f) ? (u + '?v=' + _pv) : u;
      };
    }
    importScripts('dolphin_worker_emcc.js?v=' + Date.now());
    return;
  }

  var bootstrapped = false;
  var earlyQueue = [];
  var shimOnMessage = function (e) {
    var data = (e && e.data) || {};
    if (!bootstrapped) {
      if (data.cmd === 'mem-init' && data.memory instanceof WebAssembly.Memory) {
        self.Module = self.Module || {};
        self.Module.wasmMemory = data.memory;
        // Default locateFile so dolphin_worker_emcc.wasm resolves. Cache-bust
        // the .wasm — the emcc.js is loaded with ?v=Date.now() but the .wasm was
        // fetched by bare filename, so the worker could reuse a STALE cached
        // .wasm against a fresh JS EM_ASM table ("No EM_ASM constant ... out of
        // sync" / new EM_ASM blocks silently not firing). setCacheEnabled(false)
        // on the page doesn't cover worker fetches.
        if (!self.Module.locateFile) {
          var _wv = Date.now();
          self.Module.locateFile = function (f) {
            var u = new URL(f, self.location.href).href;
            return /\.wasm($|\?)/.test(f) ? (u + '?v=' + _wv) : u;
          };
        }
        // Bridge emscripten stdout/stderr to the page console. Without this,
        // Dolphin's LogManager fprintf(stderr, ...) writes from
        // ConsoleListenerNix don't reach the JS console under PROXY_TO_PTHREAD
        // → no "Patching OSReport" / "5097 symbols loaded" / OSREPORT prints
        // visible. With this, the same NOTICE-level lines that appear in
        // native dolphin.log will appear in the page console too.
        self.Module.print    = function (t) { postMessage({ cmd: 'print', txt: '[stdout] ' + t }); };
        self.Module.printErr = function (t) { postMessage({ cmd: 'print', txt: '[stderr] ' + t }); };
        // [HW-render] The page transferred an OffscreenCanvas. Emscripten's
        // pthread_create canvas-transfer (which hands "#canvas" to the
        // PROXY_TO_PTHREAD proxied main pthread, where the OGL backend + GL
        // context live) takes the `!ENVIRONMENT_IS_PTHREAD` path and expects a
        // DOM-canvas-like object with `.id` + `transferControlToOffscreen()` —
        // our object is ALREADY an OffscreenCanvas (no such method, no `.id`),
        // so the transfer fails (err 52) and create_context('#canvas') returns
        // 0 on the pthread. GL.offscreenCanvases is module-private (can't be
        // populated from here), so wrap the OffscreenCanvas in a faux-canvas
        // whose transferControlToOffscreen() yields it — emscripten then
        // re-transfers it to the pthread and "#canvas" resolves there.
        if (data.offscreen) {
          var _off = data.offscreen;
          // Keep the OffscreenCanvas ATTACHED on the worker-main and DON'T set
          // transferredCanvasNames / a transferControlToOffscreen wrapper — those
          // make emscripten ship the canvas to a pthread, detaching it. We instead
          // register it directly into GL.offscreenCanvases in EmscriptenWorker
          // (MAIN_THREAD_EM_ASM has GL scope) and create the context here on the
          // worker-main via proxyContextToMainThread + OFFSCREEN_FRAMEBUFFER.
          self.Module.canvas = _off;
          self.Module.hwOffscreenCanvas = _off;
          postMessage({ cmd: 'print', txt: '[shim] OffscreenCanvas attached on worker-main '
            + _off.width + 'x' + _off.height + ' for HW render' });
        }
        // [FIX#1 render-worker] Set the flag on Module BEFORE importing the emcc
        // module so EmscriptenWorker's EM_ASM gate sees it. The GL ring + ctrl
        // block live in the shared wasm heap (descriptor at GL_DESC_OFF), so no
        // SABs are stashed here. gl-record.js (the producer, self.__GLRecord) is
        // loaded on worker-main here; installGLRecorder importScripts it on the
        // pthread itself when needed.
        if (data.gcRenderWorker) {
          self.Module.__gcRenderWorker = true;
          // The visible canvas went to the render worker, so worker_0 has no
          // hwOffscreenCanvas. Give emscripten a THROWAWAY 1x1 OffscreenCanvas
          // as the "#canvas" target so the normal emscripten_webgl_create_context
          // C path makes a REAL context (Dolphin's get_proc_address resolves
          // against it; without it boot call_indirects a null function). We never
          // present to this canvas — the recorder overlay diverts draws to the
          // render worker; this only keeps emscripten's GL infrastructure real.
          try {
            if (!self.Module.hwOffscreenCanvas && typeof OffscreenCanvas !== 'undefined') {
              self.Module.hwOffscreenCanvas = new OffscreenCanvas(640, 480);
            }
          } catch (e) {}
          try {
            importScripts('/gamecube/gl-record.js?v=' + Date.now());
            postMessage({ cmd: 'print', txt: '[shim] FIX#1 gl-record.js loaded (worker-main)' });
          } catch (e) {
            postMessage({ cmd: 'print', txt: '[shim] FIX#1 gl-record.js load failed: ' + (e && e.message ? e.message : e) });
            self.Module.__gcRenderWorker = false;
          }
        }
        bootstrapped = true;
        postMessage({ cmd: 'print', txt: '[shim] mem-init received, importScripts dolphin_worker_emcc.js' });
        try {
          importScripts('dolphin_worker_emcc.js?v=' + Date.now());
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[shim] importScripts failed: ' + (err && err.message ? err.message : String(err)) });
          return;
        }
        // Bootstrapper has now installed its own self.onmessage. Replay
        // anything we queued so the cascade doesn't stall.
        if (typeof self.onmessage === 'function' && self.onmessage !== shimOnMessage) {
          for (var i = 0; i < earlyQueue.length; ++i) {
            try { self.onmessage(earlyQueue[i]); } catch (err) { /* swallow */ }
          }
        }
        earlyQueue = [];
        return;
      }
      // Not mem-init yet — queue and wait.
      earlyQueue.push(e);
      return;
    }
    // After bootstrap, the bootstrapper's onmessage is installed.
  };
  self.onmessage = shimOnMessage;
})();
