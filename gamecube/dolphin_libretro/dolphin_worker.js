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
    // [print relay 2026-10-01] {cmd:'print'} from a PTHREAD does not reach the page. A
    // pthread's parent is the emscripten main worker, whose PThread worker.onmessage
    // (dolphin_worker_emcc.js) knows checkMailbox/spawnThread/cleanupThread/loaded/
    // callHandler and nothing else, so every such post ended as err("worker sent an
    // unknown command print"): the real text was LOST and the page got that line instead
    // (700+ times in one phone session). Every pthread print site posts {cmd:'print'} —
    // ConsoleListenerNix.cpp's EM_ASM, worker_funcs.js, the overrides below — so this ONE
    // wrapper rewrites them into emscripten's own callHandler protocol, which the parent
    // runs as Module.print (the shim's page relay). It also rate-limits, because each
    // line costs two postMessages and a main-thread log append: consecutive duplicates
    // collapse, the first 300 lines pass, then at most 20 per 10 s plus a count of what
    // was dropped.
    (function () {
      var rawPost = self.postMessage.bind(self);
      var total = 0, winStart = 0, winN = 0, dropped = 0, lastTxt = null, rep = 0;
      var send = function (txt) { rawPost({ cmd: 'callHandler', handler: 'print', args: [txt] }); };
      self.postMessage = function (m, transfer) {
        if (!m || m.cmd !== 'print') return transfer === undefined ? rawPost(m) : rawPost(m, transfer);
        var txt = String(m.txt);
        if (txt === lastTxt) { rep++; return; }
        if (rep > 0) { send(lastTxt + '  (repeated ' + rep + ' more times)'); rep = 0; }
        lastTxt = txt;
        var now = Date.now();
        if (now - winStart > 10000) {
          if (dropped > 0) send('[print relay] ' + dropped + ' pthread log lines suppressed in the last window');
          winStart = now; winN = 0; dropped = 0;
        }
        total++;
        if (total > 300 && ++winN > 20) { dropped++; return; }
        send(txt);
      };
    })();
    self.Module = self.Module || {};
    self.Module.print    = function (t) { postMessage({ cmd: 'print', txt: '[dolphin:stdout] ' + t }); };
    self.Module.printErr = function (t) { postMessage({ cmd: 'print', txt: '[dolphin:stderr] ' + t }); };
    // [worker-error capture 2026-07-22] A wasm trap / uncaught error in ANY pthread (incl. the
    // gpu_thread) was INVISIBLE: emscripten's own handlers don't reach the page, and the probe's
    // pageerror never fires for worker deaths. Ride the same {cmd:'print'} relay the
    // stdout/stderr bridge above uses (proven to reach the page console).
    self.addEventListener('error', function (ev) {
      try { postMessage({ cmd: 'print', txt: '[pthread-ERROR ' + self.name + '] '
        + (ev && (ev.message || ev.type)) + ' @' + (ev && ev.filename) + ':' + (ev && ev.lineno) }); } catch (_) {}
    });
    self.addEventListener('unhandledrejection', function (ev) {
      try { postMessage({ cmd: 'print', txt: '[pthread-REJECT ' + self.name + '] ' + (ev && ev.reason) }); } catch (_) {}
    });
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

  // [main-thread 2026-10-01] AUDIO STRAIGHT INTO THE WORKLET RING, NOT THROUGH THE PAGE.
  // audio_sample_batch_cb (EmscriptenWorker.cpp) runs a MAIN_THREAD_ASYNC_EM_ASM on THIS
  // worker that does `postMessage({cmd:'audio', buf, len})` — one message per ~96-frame batch,
  // 333/s measured on SAB, each a task + structured-clone deserialize on the page's main thread
  // just to copy ~384 B into a SharedArrayBuffer ring the page does not otherwise touch.
  // Once the page hands over that ring ({cmd:'audioRing', sab}), the batch is written here with
  // the page's own pushAudioSamples logic (same header layout: [0]=head, [1]=tail, [2]=capacity
  // in int16 elements; same drop-on-full rule) and the page gets one {cmd:'audioStat'} a second
  // carrying the frame counts its [audio-diag] accounting needs. `sab: null` hands the ring
  // back (mute, or the recomp taking over as producer). Before any hand-off the old per-batch
  // message is posted unchanged, so a page that never sends a ring behaves exactly as before.
  var audRing = null, audHdr = null, audData = null, audCap = 0;
  var audFrames = 0, audFull = 0, audStatAt = 0;
  function audStatFlush(now) {
    audStatAt = now;
    if (audFrames || audFull) {
      rawPostMessage({ cmd: 'audioStat', frames: audFrames, dropped: audFull });
      audFrames = 0; audFull = 0;
    }
  }
  function audWrite(u8, byteLen) {
    var src = new Int16Array(u8.buffer, u8.byteOffset || 0, (byteLen | 0) >> 1);
    audFrames += src.length >> 1;
    if (audHdr) {
      var head = Atomics.load(audHdr, 0), tail = Atomics.load(audHdr, 1);
      var free = audCap - ((head - tail) | 0);
      var n = src.length > free ? free : src.length;
      if (n < src.length) audFull += (src.length - n) >> 1;
      if (n > 0) {
        var start = (head >>> 0) % audCap, first = Math.min(n, audCap - start);
        audData.set(src.subarray(0, first), start);
        if (n > first) audData.set(src.subarray(first, n), 0);
        Atomics.store(audHdr, 0, (head + n) | 0);
      }
    }
    var now = Date.now();
    if (now - audStatAt >= 1000) audStatFlush(now);
  }
  var rawPostMessage = self.postMessage.bind(self);
  self.postMessage = function (m, transfer) {
    if (audRing !== null && m && m.cmd === 'audio' && m.buf) { audWrite(m.buf, m.len); return; }
    return transfer === undefined ? rawPostMessage(m) : rawPostMessage(m, transfer);
  };
  // Registered BEFORE self.onmessage is first assigned, so it runs ahead of the emscripten
  // handler and can keep this page->shim command away from it ('unknown cmd' otherwise).
  self.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.cmd !== 'audioRing') return;
    e.stopImmediatePropagation();
    if (d.sab instanceof SharedArrayBuffer) {
      audRing = d.sab;
      audHdr = new Int32Array(d.sab, 0, 4);
      audCap = audHdr[2] | 0;
      audData = new Int16Array(d.sab, 16, audCap);
    } else if (audRing !== null) {
      // handed back: keep swallowing the batches (counted, not written) so the page is not
      // flooded again while muted / after the recomp takes over as the producer.
      audRing = false; audHdr = null; audData = null; audCap = 0;
    }
    audStatFlush(Date.now());
  });

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
        // [region-sweep] Apply BJIT_* tuning env vars from the page URL (getenv-read
        // by the JIT block-cache region caps — sweep coverage with NO rebuild).
        if (data.bjitEnv) {
          self.Module.ENV = self.Module.ENV || {};
          for (var _k in data.bjitEnv) {
            self.Module.ENV[_k] = String(data.bjitEnv[_k]);
            postMessage({ cmd: 'print', txt: '[shim] ENV ' + _k + '=' + data.bjitEnv[_k] });
          }
        }
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
          if (data.wgpu) {
            // [WGPU present — CORRECTED 2026-07-13] The claim below ("no WebGPU surface, the
            // worker does NOT need the page canvas") was FALSE: emdawnwebgpu fully supports a
            // direct canvas surface present, and the page canvas CAN be routed to the proxied
            // pthread (faux-canvas + transferredCanvasNames). The readback is a self-imposed M1
            // shortcut. It is kept for now because converting to direct present does NOT raise
            // fps (the worker's jit is the frame-rate wall; the readback is async, off the
            // worker's critical path) — it's a quality/latency change, tracked in memory
            // gc_wgpu_readback_present_is_avoidable_direct_canvas_2026_07_13. Current behavior:
            // render to an offscreen texture, read back, postMessage pixels; GC_WGPU skips WebGL.
            self.Module.canvas = _off;
            self.Module.hwOffscreenCanvas = _off;
            self.Module.ENV = self.Module.ENV || {};
            self.Module.ENV.GC_WGPU = '1';
            postMessage({ cmd: 'print', txt: '[shim] WGPU: offscreen render-to-texture mode '
              + '(page canvas not used) ' + _off.width + 'x' + _off.height });
          } else {
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
