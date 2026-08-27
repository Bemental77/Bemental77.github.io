// dreamcast/flycast_libretro/flycast_worker.js — outer worker shim.
//
// Mirror of gamecube/dolphin_libretro/dolphin_worker.js. The page does
//   new Worker('/dreamcast/flycast_libretro/flycast_worker.js', { type: 'classic' })
// and immediately postMessages { cmd: 'mem-init', memory: <SAB-backed
// WebAssembly.Memory> }. We stash that memory on Module.wasmMemory BEFORE
// importing the emcc-generated factory so flycast's wasm imports the same
// memory the page sees.
//
// The factory itself is the --post-js'd flycast_worker_funcs.js + the emcc
// runtime emitted by flycast_worker_link.sh into flycast_worker.js. With
// MODULARIZE=1 EXPORT_NAME=flycastWorkerModule, that file exports a global
// `flycastWorkerModule` factory function we instantiate ourselves.
//
// Phase 1 single-worker. Phase 2 (sh4-worker mailbox) is deferred — see the
// gamecube/ppc-worker pattern when that lands.
//
// NOTE: PROXY_TO_PTHREAD=1 in the link script means the emcc factory spawns
// child pthread workers using *this same script*. Those children get
// self.name === 'em-pthread' and load the factory immediately without
// waiting for mem-init (mirrors the dolphin_worker.js shim pattern).

(function () {
  // Lever-4 D1 (strip after verdict): capture uncaught worker errors WITH the
  // wasm stack — `wasm-function[NNNN]` frames name the trapping function and
  // discriminate static-module code from runtime-JIT'd block modules.
  if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
    // console.error reaches the probe from BOTH the main worker and pthread
    // children (a child's postMessage goes to the emcc parent protocol and is
    // swallowed as "unknown command"). The trap's own realm has err.stack —
    // wasm-function[NNNN] frames name the trapping function.
    var werrLog = function (tag, msg, stk) {
      var line = tag + ' [' + (self.name || 'main-worker') + '] ' + msg +
        (stk ? ' stack=' + String(stk).split('\n').slice(0, 12).join(' | ') : ' (no stack)');
      try { console.error(line); } catch (_) {}
      try { postMessage({ cmd: 'print', txt: line }); } catch (_) {}
    };
    self.addEventListener('error', function (e) {
      try {
        werrLog('[werr]', (e && e.message) + ' @' + (e && e.filename) + ':' + (e && e.lineno),
                e && e.error && e.error.stack);
      } catch (_) {}
    });
    self.addEventListener('unhandledrejection', function (e) {
      try {
        var r = e && e.reason;
        werrLog('[wrej]', (r && r.message ? r.message : String(r)), r && r.stack);
      } catch (_) {}
    });
  }
  // Pthread children: emcc spawned us as `new Worker(_scriptName, { name: 'em-pthread' })`
  // where `_scriptName` resolves to THIS shim's URL — not the factory's. Load
  // the factory directly so its top-level pthread-bootstrap fires.
  if (typeof self !== 'undefined' && self.name === 'em-pthread') {
    importScripts('flycast_worker_emcc.js');
    return;
  }

  // ---------------------------------------------------------------------------
  // Reuse SAB primitives from the gamecube tree — they're not gamecube-specific.
  // (importScripts is fine in classic-mode workers; module-mode would need
  // top-level await which the emcc factory output doesn't support today.)
  // ---------------------------------------------------------------------------
  try {
    importScripts('/lib/seqlock.js');
    importScripts('/lib/ringbuffer.js');
  } catch (e) {
    // Non-fatal: the SAB primitives are used by Phase 2 paths (sh4-worker
    // mailbox + audio ring inspection). Phase 1 only needs raw SAB views.
    postMessage({ cmd: 'print', txt: '[flycast-shim] SAB primitives import skipped: ' + e });
  }

  let bootstrapped = false;
  let earlyQueue   = [];
  let sharedMemory = null;
  let fbCfg = null;     // { offset, w, h }
  let audioCfg = null;  // { offset, frames }

  function shimOnMessage(e) {
    const data = (e && e.data) || {};
    if (!bootstrapped) {
      if (data.cmd === 'mem-init' && data.memory instanceof WebAssembly.Memory) {
        sharedMemory = data.memory;
        fbCfg    = { offset: data.fbOffset, w: data.fbW, h: data.fbH };
        audioCfg = { offset: data.audioOffset, frames: data.audioFrames };

        bootstrapped = true;
        postMessage({ cmd: 'print', txt: '[flycast-shim] mem-init received, importScripts factory' });
        try {
          importScripts('flycast_worker_emcc.js?v=' + Date.now());
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] importScripts failed: ' + (err && err.message ? err.message : String(err)) });
          return;
        }
        // MODULARIZE=1 EXPORT_NAME=flycastWorkerModule — the file just defines
        // a global factory function; we must invoke it with the module config
        // for the runtime to actually start. Returns a promise that resolves
        // when (or rejects if) the runtime is up.
        if (typeof flycastWorkerModule !== 'function') {
          postMessage({ cmd: 'print', txt: '[flycast-shim] flycastWorkerModule global missing after importScripts' });
          return;
        }
        // OffscreenCanvas was transferred from the page via mem-init.
        // Stash it for the preRun hook to register with Emscripten's GL.
        const transferredOffscreen = data.offscreen;
        const moduleArg = {
          wasmMemory: sharedMemory,
          locateFile: function (f) { return new URL(f, self.location.href).href; },
          // Pthread spawn uses _scriptName by default → our shim. Force the
          // factory URL instead so pthread workers load the emcc bootstrap.
          mainScriptUrlOrBlob: new URL('flycast_worker_emcc.js', self.location.href).href,
          print:       function (s) { postMessage({ cmd: 'print', txt: '[wasm.out] ' + s }); },
          printErr:    function (s) { postMessage({ cmd: 'print', txt: '[wasm.err] ' + s }); },
          onAbort: function (why) { postMessage({ cmd: 'print', txt: '[flycast-shim] ABORT: ' + why }); },
          canvas: transferredOffscreen,
          // Emscripten's pthread runtime iterates Module.transferredCanvasNames
          // when spawning a pthread that needs the OffscreenCanvas transferred
          // to it. With OFFSCREENCANVAS_SUPPORT=1 link flag, this MUST be an
          // iterable (array) — undefined throws "transferredCanvasNames is not
          // iterable" on every retro_run that touches pthread-side GL.
          transferredCanvasNames: ['#canvas'],
        };
        flycastWorkerModule(moduleArg).then(
          function (mod) {
            // mod IS moduleArg post-mutation, with all _emscripten_* exports.
            self.Module = mod;
            // Ensure transferredCanvasNames survives factory mutation.
            if (!Array.isArray(mod.transferredCanvasNames)) {
              mod.transferredCanvasNames = ['#canvas'];
              postMessage({ cmd: 'print', txt: '[flycast-shim] re-attached transferredCanvasNames to Module' });
            }
            // Also stash on self.PThread if Emscripten set that up.
            if (typeof self.PThread === 'object' && self.PThread) {
              if (!Array.isArray(self.PThread.transferredCanvasNames)) {
                self.PThread.transferredCanvasNames = ['#canvas'];
              }
            }
            onRuntimeInitialized();
          },
          function (err) {
            postMessage({ cmd: 'print', txt: '[flycast-shim] factory rejected: ' + (err && err.message ? err.message : String(err)) });
          }
        );
        // Replay anything we queued so the page's earlier messages aren't lost.
        if (typeof self.onmessage === 'function' && self.onmessage !== shimOnMessage) {
          for (const ev of earlyQueue) {
            try { self.onmessage(ev); } catch (_) {}
          }
        }
        earlyQueue = [];
        return;
      }
      // Pre-mem-init: queue everything else.
      earlyQueue.push(e);
      return;
    }
    // After bootstrap the post-js installs its own onmessage handler.
  }
  self.onmessage = shimOnMessage;

  // ---------------------------------------------------------------------------
  // onRuntimeInitialized — emcc runtime up. We can safely call trivial exports
  // (pure global stores) from this worker thread now, but anything that hits
  // Asyncify-instrumented code (malloc, sigaction, FS, locale, dynarec setup)
  // must run on the pthread that owns the per-thread Asyncify frame — i.e.
  // the pthread that runs main(). So we only wire the SAB-pointer exports
  // here; retro_init() happens inside main() (see EmscriptenWorker.cpp:main).
  // The page-facing 'ready' message is posted once we receive 'core-ready'
  // from main via postMessage.
  // ---------------------------------------------------------------------------
  let coreReady = false;
  let videoAudioWired = false;

  function maybePostReady() {
    if (coreReady && videoAudioWired) {
      postMessage({ cmd: 'print', txt: '[flycast-shim] runtime + core ready' });
      postMessage({ cmd: 'ready' });
    }
  }

  function onRuntimeInitialized() {
    const Module = self.Module;
    try {
      // SAB-pointer wiring — trivial global stores, safe from this thread.
      Module._emscripten_set_video_target(fbCfg.offset >>> 0, fbCfg.w | 0, fbCfg.h | 0);
      Module._emscripten_set_audio_ring(audioCfg.offset >>> 0, audioCfg.frames | 0);
      videoAudioWired = true;
      // Register offscreen canvas into Module.GL — now safe (runtime up).
      try {
        if (Module.GL && Module.canvas) {
          const entry = { offscreenCanvas: Module.canvas };
          Module.GL.offscreenCanvases = Module.GL.offscreenCanvases || {};
          Module.GL.offscreenCanvases['#canvas']     = entry;
          Module.GL.offscreenCanvases['canvas']      = entry;
          Module.GL.offscreenCanvases['#dc-canvas']  = entry;
          postMessage({ cmd: 'print', txt: '[flycast-shim] registered offscreen in GL.offscreenCanvases' });
        } else {
          postMessage({ cmd: 'print', txt: '[flycast-shim] cannot register offscreen (GL=' + !!Module.GL + ' canvas=' + !!Module.canvas + ')' });
        }
      } catch (e) {
        postMessage({ cmd: 'print', txt: '[flycast-shim] offscreen register threw: ' + (e && e.message ? e.message : String(e)) });
      }
      // Session build's main() just idles; explicit init required.
      try {
        if (typeof Module._emscripten_create_gl_context === 'function') {
          const handle = Module._emscripten_create_gl_context();
          postMessage({ cmd: 'print', txt: '[flycast-shim] create_gl_context returned ' + handle });
        }
      } catch (e) {
        postMessage({ cmd: 'print', txt: '[flycast-shim] create_gl_context threw: ' + (e && e.message ? e.message : String(e)) });
      }
      try {
        if (typeof Module._emscripten_worker_init === 'function') {
          Module._emscripten_worker_init();
          postMessage({ cmd: 'print', txt: '[flycast-shim] worker_init returned' });
        }
      } catch (e) {
        postMessage({ cmd: 'print', txt: '[flycast-shim] worker_init threw: ' + (e && e.message ? e.message : String(e)) });
      }
      coreReady = true;
      maybePostReady();
    } catch (err) {
      postMessage({ cmd: 'print', txt: '[flycast-shim] runtime-init threw: ' + (err && err.message ? err.message : String(err)) });
    }

    // Install the user-facing onmessage handler. The post-js
    // (flycast_worker_funcs.js) may also install one — both will be reached
    // via the dispatcher below.
    self.onmessage = onCmd;
    // Drain anything that came in during the bootstrap window.
    for (const ev of earlyQueue) { try { onCmd(ev); } catch (_) {} }
    earlyQueue = [];
  }

  // Intercept the worker's outgoing postMessage stream to observe 'core-ready'
  // sent from main()'s MAIN_THREAD_EM_ASM body. MAIN_THREAD_EM_ASM runs JS on
  // the main browser thread = this worker's own scope, so the postMessage
  // calls inside main() go through self.postMessage here before reaching the
  // page. We pass everything else through unchanged.
  const _origPostMessage = self.postMessage.bind(self);
  self.postMessage = function (msg, transfer) {
    if (msg && msg.cmd === 'core-ready') {
      coreReady = true;
      maybePostReady();
    }
    if (transfer) _origPostMessage(msg, transfer);
    else _origPostMessage(msg);
  };

  // ---------------------------------------------------------------------------
  // Worker message dispatcher. Handles all 7 page-side commands:
  //   mem-init / discChunk / discReady / runFrame / reset / saveState /
  //   loadState.   Plus 'input' for pad bytes.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Free-run pump (charter Phase 2.2): the worker owns the run loop; the page
  // only sends input. Decouples guest progress from page vsync — rAF pacing
  // stalls to zero in a backgrounded tab and couples boot/emu speed to message
  // latency. A zero-delay MessageChannel macrotask loop keeps the worker
  // saturated while still yielding between iterations so incoming page
  // messages (input, reset, saveState) interleave. Frame limiter: once an
  // iteration completes in under ~16.7ms we schedule the remainder so guest
  // speed caps at 60 iterations/s.
  // ---------------------------------------------------------------------------
  let freerun = false;
  let freerunIters = 0;
  let freerunStatsTimer = 0;
  let pendingSave = false;   // Save State, deferred to a clean asyncify boundary (pumpTick)
  const FRAME_MS = 1000 / 60;
  // Real-time governor (2026-08-27): pace WALL time against GUEST time at the
  // real SH4 clock — the old 60-iteration cap limits RENDERED frames, and one
  // retro_run runs until a frame renders, so 30fps content passed 2 guest
  // VBlanks per iteration and the game ran ~2x once throughput beat native.
  // Cycle pacing is content-agnostic: 1 guest second per wall second, exactly.
  // 'uncap' (perf probes: ?uncap=1) restores the historical free-run behavior.
  const SH4_HZ = 200000000;
  let uncap = false;
  let paceBaseWall = 0, paceBaseCyc = 0;
  function resetPace() { paceBaseWall = 0; paceBaseCyc = 0; }
  const pumpChannel = new MessageChannel();
  pumpChannel.port1.onmessage = pumpTick;

  // Asyncify-suspension guard: run_iter can SUSPEND internally (asyncify);
  // its export then returns immediately with the C-side in-flight flag still
  // set. Re-entering while suspended corrupts the asyncify state machine
  // (boot-title-wedge H2 — confirmed by frozen fps/clk telemetry while pump
  // iters kept counting no-op re-entries). Read the flag via HEAPU8 — a heap
  // read is safe while suspended; a wasm call is not.
  let runIterFlagPtr = 0;
  function runIterSuspended() {
    const Module = self.Module;
    if (!runIterFlagPtr && Module && typeof Module._flycast_run_iter_flag_ptr === 'function') {
      try { runIterFlagPtr = Module._flycast_run_iter_flag_ptr() >>> 0; } catch (_) {}
    }
    return runIterFlagPtr !== 0 && Module.HEAPU8[runIterFlagPtr] !== 0;
  }

  function pumpTick() {
    if (!freerun) return;
    const Module = self.Module;
    if (runIterSuspended()) {
      // Let the suspended frame's own timer rewind and finish; check back.
      setTimeout(() => pumpChannel.port2.postMessage(0), 4);
      return;
    }
    // Clean asyncify boundary (run_iter is NOT suspended): the only safe point to
    // serialize. Saving from the message handler while a frame is asyncify-suspended
    // corrupts the frame, so the next run_iter unwinds and the pump freezes — which
    // is what made Save State "break". Do the deferred save here instead.
    if (pendingSave) { pendingSave = false; doSaveState(); }
    const t0 = performance.now();
    try {
      Module._emscripten_run_iter();
      freerunIters++;
    } catch (err) {
      freerun = false;
      if (freerunStatsTimer) { clearInterval(freerunStatsTimer); freerunStatsTimer = 0; }
      var pcTxt = '';
      try { if (Module._flycast_get_sh4_pc) pcTxt = ' sh4_pc=0x' + (Module._flycast_get_sh4_pc() >>> 0).toString(16); } catch (_) {}
      var stk = (err && err.stack) ? (' stack=' + String(err.stack).split('\n').slice(0, 4).join(' | ')) : '';
      postMessage({ cmd: 'print', txt: '[flycast-shim] freerun run_iter threw (pump stopped): ' + (err && err.message ? err.message : String(err)) + pcTxt + stk });
      return;
    }
    let delay = 0;
    if (!uncap && typeof Module._flycast_guest_cycles === 'function') {
      // Governor: schedule the next iteration so guest time never leads wall
      // time. A large desync in either direction (background tab, level load,
      // state jump — the cycle counter jumps on unserialize) rebases instead
      // of sprinting or stalling to catch up.
      const nowW = performance.now();
      const cyc = Module._flycast_guest_cycles();
      if (!paceBaseWall) { paceBaseWall = nowW; paceBaseCyc = cyc; }
      const lead = (cyc - paceBaseCyc) / SH4_HZ * 1000 - (nowW - paceBaseWall);
      if (lead < -250 || lead > 250) { paceBaseWall = nowW; paceBaseCyc = cyc; }
      else delay = Math.max(0, Math.min(50, lead));
    } else {
      // uncap / no export: historical free-run frame limiter (perf baselines).
      const elapsed = performance.now() - t0;
      delay = FRAME_MS - elapsed;
    }
    if (delay > 1) setTimeout(() => pumpChannel.port2.postMessage(0), delay);
    else pumpChannel.port2.postMessage(0);
  }

  // Serialize the full emulator state and hand the bytes to the page. MUST be
  // called only at a clean asyncify boundary (from pumpTick, or when not
  // free-running) — see the pendingSave note above.
  function doSaveState() {
    const Module = self.Module;
    try {
      const ppOut  = Module._malloc(4);
      const ppSize = Module._malloc(4);
      const ok = Module._emscripten_save_state(ppOut, ppSize);
      if (!ok) {
        Module._free(ppOut); Module._free(ppSize);
        postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) });
        return;
      }
      const bufPtr = Module.HEAPU32[ppOut >>> 2];
      const size   = Module.HEAPU32[ppSize >>> 2];
      const out = new Uint8Array(Module.HEAPU8.subarray(bufPtr, bufPtr + size));
      Module._free(bufPtr);
      Module._free(ppOut); Module._free(ppSize);
      postMessage({ cmd: 'stateSaved', data: out }, [out.buffer]);
    } catch (err) {
      postMessage({ cmd: 'print', txt: '[flycast-shim] saveState threw: ' + (err && err.message ? err.message : String(err)) });
      postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) });
    }
  }

  function setFreerun(on) {
    if (on && !freerun) {
      freerun = true;
      freerunIters = 0;
      freerunStatsTimer = setInterval(() => {
        postMessage({ cmd: 'ips', ips: freerunIters });
        freerunIters = 0;
      }, 1000);
      postMessage({ cmd: 'print', txt: '[flycast-shim] freerun ON (worker-owned run loop, 60 iter/s cap)' });
      pumpChannel.port2.postMessage(0);
    } else if (!on && freerun) {
      freerun = false;
      if (freerunStatsTimer) { clearInterval(freerunStatsTimer); freerunStatsTimer = 0; }
      postMessage({ cmd: 'print', txt: '[flycast-shim] freerun OFF' });
    }
  }

  function onCmd(e) {
    const Module = self.Module;
    const data = (e && e.data) || {};
    switch (data.cmd) {
      case 'freerun':
        setFreerun(!!data.on);
        break;
      case 'uncap':   // perf probes (?uncap=1): historical free-run pump
        uncap = !!data.on;
        resetPace();
        postMessage({ cmd: 'print', txt: '[pump] uncap=' + (uncap ? 1 : 0) + ' (real-time governor ' + (uncap ? 'OFF' : 'ON') + ')' });
        break;
      case 'mem-init':
        // Already bootstrapped — ignore late re-sends.
        return;

      case 'discChunk': {
        // Stream the disc into MEMFS at /discs/<name>. .cue references its
        // .bin tracks by relative filename, so we mkdir /discs once and
        // keep all of cue + bin in the same directory.
        try { Module.FS.mkdir('/discs'); } catch (_) {}
        const u8 = new Uint8Array(data.bytes);
        const path = '/discs/' + data.name;
        Module.FS.writeFile(path, u8);
        postMessage({ cmd: 'print', txt: '[flycast-shim] wrote ' + path + ' (' + u8.byteLength + ' B)' });
        break;
      }

      case 'discReady': {
        try {
          const ret = Module.ccall('emscripten_load_disc', 'number', ['string'], [data.cuePath]);
          postMessage({ cmd: 'discLoaded', cuePath: data.cuePath, success: !!ret });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] load_disc threw: ' + (err && err.message ? err.message : String(err)) });
          postMessage({ cmd: 'discLoaded', cuePath: data.cuePath, success: false });
        }
        break;
      }

      case 'runFrame': {
        if (freerun) break;  // pump owns the loop; ignore legacy page pacing
        if (runIterSuspended()) break;  // asyncify frame in flight — skip
        try {
          Module._emscripten_run_iter();
          postMessage({ cmd: 'frame' });
        } catch (err) {
          var pcTxt = '';
          try { if (Module._flycast_get_sh4_pc) pcTxt = ' sh4_pc=0x' + (Module._flycast_get_sh4_pc() >>> 0).toString(16); } catch (_) {}
          var stk = (err && err.stack) ? (' stack=' + String(err.stack).split('\n').slice(0,4).join(' | ')) : '';
          postMessage({ cmd: 'print', txt: '[flycast-shim] run_iter threw: ' + (err && err.message ? err.message : String(err)) + pcTxt + stk });
        }
        break;
      }

      case 'input': {
        // Page-supplied 256-byte pad buffer. Copy into the worker's
        // g_maple_pad_state via the maple ptr export.
        try {
          const ptr = Module._emscripten_get_maple_ptr() >>> 0;
          if (ptr && data.states) {
            Module.HEAPU8.set(new Uint8Array(data.states), ptr);
          }
        } catch (err) {
          // Silent — pad updates are 60 Hz and any spam would drown the log.
        }
        break;
      }

      case 'reset': {
        try {
          resetPace();
          Module._emscripten_reset();
          postMessage({ cmd: 'print', txt: '[flycast-shim] reset done' });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] reset threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'diag': {
        try {
          if (typeof Module._flycast_diag_set === 'function') {
            Module._flycast_diag_set(data.on ? 1 : 0);
            postMessage({ cmd: 'print', txt: '[flycast-shim] diag ' + (data.on ? 'ON' : 'OFF') });
          }
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] diag threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'interpRange': {
        try {
          if (typeof Module._flycast_set_interp_range === 'function') {
            Module._flycast_set_interp_range(data.lo >>> 0, data.hi >>> 0);
            postMessage({ cmd: 'print', txt: '[flycast-shim] interp range 0x' +
              (data.lo >>> 0).toString(16) + '..0x' + (data.hi >>> 0).toString(16) });
          }
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] interpRange threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'immfast': {
        try {
          if (typeof Module._flycast_set_imm_fastpath === 'function') {
            Module._flycast_set_imm_fastpath(data.on ? 1 : 0);
            postMessage({ cmd: 'print', txt: '[flycast-shim] imm fastpath ' + (data.on ? 'ON' : 'OFF') });
          }
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] immfast threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'regcache': {
        try {
          if (typeof Module._flycast_set_regcache === 'function') {
            Module._flycast_set_regcache(data.on ? 1 : 0);
            postMessage({ cmd: 'print', txt: '[flycast-shim] regcache ' + (data.on ? 'ON' : 'OFF') });
          }
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] regcache threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'memfast': {
        try {
          if (typeof Module._flycast_set_mem_fastpaths === 'function') {
            Module._flycast_set_mem_fastpaths(data.on ? 1 : 0);
            postMessage({ cmd: 'print', txt: '[flycast-shim] mem fastpaths ' + (data.on ? 'ON' : 'OFF') });
          }
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] memfast threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'interp': {
        try {
          if (typeof Module._flycast_set_interp_only === 'function') {
            Module._flycast_set_interp_only(data.on ? 1 : 0);
            postMessage({ cmd: 'print', txt: '[flycast-shim] interp ' + (data.on ? 'ON' : 'OFF') });
          }
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] interp threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'pctrace': {
        try {
          if (typeof Module._flycast_set_pc_trace_until === 'function') {
            Module._flycast_set_pc_trace_until(data.n >>> 0);
            postMessage({ cmd: 'print', txt: '[flycast-shim] pctrace until=' + (data.n >>> 0) });
          }
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] pctrace threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'saveState': {
        // Free-running: defer the serialize to a clean asyncify boundary in the
        // pump (saving mid-suspend freezes the emulation). Not running: the frame
        // isn't in flight, so serialize immediately.
        if (freerun) pendingSave = true;
        else doSaveState();
        break;
      }

      case 'loadState': {
        try {
          resetPace();   // cycle counter jumps on unserialize
          const src = data.data ? new Uint8Array(data.data) : new Uint8Array(0);
          const ptr = Module._malloc(src.length);
          Module.HEAPU8.set(src, ptr);
          const ok = Module._emscripten_load_state(ptr, src.length);
          Module._free(ptr);
          // A preceding Save typically stopped the pump (asyncify unwind). Resume
          // it from the restored state so Load actually continues the game.
          if (ok && !freerun) { freerun = true; pumpChannel.port2.postMessage(0); }
          postMessage({ cmd: 'stateLoaded', success: !!ok });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] loadState threw: ' + (err && err.message ? err.message : String(err)) });
          postMessage({ cmd: 'stateLoaded', success: false });
        }
        break;
      }

      case 'setchain': {
        try {
          if (Module._flycast_set_chain) Module._flycast_set_chain((data.on | 0));
          postMessage({ cmd: 'print', txt: '[setchain] g_chain_enabled=' + (data.on | 0) });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[setchain] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'arm7selftest': {   // lever-7: per-block jit-vs-interp semantic self-test
        try {
          if (Module._flycast_set_arm7selftest) Module._flycast_set_arm7selftest(data.on | 0);
          postMessage({ cmd: 'print', txt: '[arm7selftest] enabled=' + (data.on | 0) });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[arm7selftest] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'arm7jit': {   // lever-7: ARM7 wasm rec toggle (v0 interp-runner arm when off)
        try {
          if (Module._flycast_set_arm7jit) Module._flycast_set_arm7jit(data.on | 0);
          postMessage({ cmd: 'print', txt: '[arm7jit] enabled=' + (data.on | 0) });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[arm7jit] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'shard': {
        try {
          if (Module._flycast_set_shard) Module._flycast_set_shard(data.on | 0);
          postMessage({ cmd: 'print', txt: '[shard] enabled=' + (data.on | 0) });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[shard] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'fog': {      // render-oracle bisect: ?nofog=1 disables PVR fog
        try {
          if (Module._flycast_set_fog) Module._flycast_set_fog(data.on | 0);
          postMessage({ cmd: 'print', txt: '[fog] enabled=' + (data.on | 0) });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[fog] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'modvol': {   // render-oracle bisect: ?nomodvol=1 disables modifier volumes
        try {
          if (Module._flycast_set_modvol) Module._flycast_set_modvol(data.on | 0);
          postMessage({ cmd: 'print', txt: '[modvol] enabled=' + (data.on | 0) });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[modvol] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'setic': {
        try {
          if (Module._flycast_set_ic) Module._flycast_set_ic((data.on | 0));
          postMessage({ cmd: 'print', txt: '[setic] armed=' + (data.on | 0) });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[setic] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      // Lever-4 task 6: in-process IC parity gate (savestate replay, warmup +
      // disarmed A/B + armed C — prints [parity] ... verdict=). Stepwise: one
      // retro_run per parity_tick at the same asyncify boundary as the pump
      // (a single C call looping retro_run dies on the first unwind). The
      // freerun pump is paused so pump frames can't leak into the arms.
      case 'parity': {
        try {
          const n = (data.n | 0) || 60;
          const fromLoad = (data.fromload | 0);   // lever-6 cert: replay the autoloaded state
          if (!Module._emscripten_parity_begin || !Module._emscripten_parity_tick) break;
          const wasFreerun = freerun;
          freerun = false;
          const finish = () => {
            freerun = wasFreerun;
            if (freerun) pumpChannel.port2.postMessage(0);
          };
          const isUnwind = (err) => err && (err === 'unwind' || err.message === 'unwind');
          const tick = () => {
            if (runIterSuspended()) { setTimeout(tick, 4); return; }
            let more = 1;
            try { more = Module._emscripten_parity_tick(); }
            catch (err) {
              if (isUnwind(err)) { setTimeout(tick, 8); return; }  // suspend escaping as throw: wait for rewind
              postMessage({ cmd: 'print', txt: '[parity] tick threw: ' + (err && err.message ? err.message : String(err)) });
              finish(); return;
            }
            if (runIterSuspended()) { setTimeout(tick, 4); return; }  // suspended inside: not done
            if (more) setTimeout(tick, 0); else finish();
          };
          const startWhenClean = () => {
            if (runIterSuspended()) { setTimeout(startWhenClean, 4); return; }
            postMessage({ cmd: 'print', txt: '[parity] running ' + n + ' frames x4 arms (stepwise)...' });
            let ok = 1;
            try { ok = Module._emscripten_parity_begin(n, fromLoad); }
            catch (err) {
              if (isUnwind(err)) { setTimeout(tick, 8); return; }   // begin suspended; it completes via rewind
              postMessage({ cmd: 'print', txt: '[parity] begin threw: ' + (err && err.message ? err.message : String(err)) });
              finish(); return;
            }
            if (runIterSuspended()) { setTimeout(tick, 4); return; } // begin suspended mid-body
            if (!ok) { finish(); return; }
            tick();
          };
          startWhenClean();
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[parity] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'setrteintc': {
        try {
          if (Module._flycast_set_rte_intc) Module._flycast_set_rte_intc((data.on | 0));
          postMessage({ cmd: 'print', txt: '[setrteintc] g_emit_rte_intc=' + (data.on | 0) });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[setrteintc] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'ctxsnap': {
        try {
          const f = Module._flycast_ctx_snapshot;
          const h = (v) => ('00000000' + ((v >>> 0).toString(16))).slice(-8);
          const s = (v) => (v | 0);  // signed view for cycle_counter/sched_next
          const pc = f(0), sr = f(1), pend = f(2), cyc = f(3), sched = f(4),
                cpu = f(5), vbr = f(6), istnrm = f(7), iml6 = f(8), spc = f(9), ssr = f(10);
          postMessage({ cmd: 'print', txt: '[ctxsnap] pc=0x' + h(pc) + ' sr=0x' + h(sr) +
            ' pend=0x' + h(pend) + ' cyc=' + s(cyc) + ' sched_next=' + s(sched) +
            ' cpu=' + (cpu >>> 0) + ' vbr=0x' + h(vbr) + ' istnrm=0x' + h(istnrm) +
            ' iml6=0x' + h(iml6) + ' spc=0x' + h(spc) + ' ssr=0x' + h(ssr) +
            ' r0=0x' + h(f(20)) + ' r7=0x' + h(f(27)) +
            ' r4=0x' + h(f(24)) + ' r5=0x' + h(f(25)) + ' r6=0x' + h(f(26)) +
            ' r8=0x' + h(f(28)) + ' r10=0x' + h(f(30)) + ' r13=0x' + h(f(33)) + ' pr=0x' + h(f(11)) +
            ' veccnt=' + (f(12) >>> 0) + ' schedticks=' + (f(13) >>> 0) +
            ' rt=' + (f(14) >>> 0) + ' rtdyn=' + (f(15) >>> 0) +
            ' rtstat=' + (f(16) >>> 0) + ' rtcond=' + (f(17) >>> 0) +
            ' chit=' + (f(18) >>> 0) + ' cmiss=' + (f(19) >>> 0) + ' mraise=' + (f(36)>>>0) + ' mclear=' + (f(37)>>>0) + ' intevt=0x' + h(f(38)) +
            ' istwr=' + (f(39)>>>0) + ' istwd=0x' + h(f(40)) +
            ' mapleH=0x' + h(f(41)) + ' vblH=0x' + h(f(42)) + ' cbHead=0x' + h(f(43)) + ' gIntevt=0x' + h(f(44)) +
            ' armed=0x' + h(f(45)) + ' mdtsel=0x' + h(f(46)) + ' gIst=0x' + h(f(47)) + ' gIml4=0x' + h(f(48)) +
            ' dodma=' + (f(49)>>>0) + ' schd=' + (f(50)>>>0) + ' cArmed0=' + (f(51)>>>0) + ' cArmed1=' + (f(52)>>>0) +
            ' n1next=0x' + h(f(53)) + ' n2fn=0x' + h(f(54)) + ' proc=' + (f(55)>>>0) + ' skip=' + (f(56)>>>0) +
            ' latch=0x' + h(f(57)) + ' d320=' + (f(58)>>>0) + ' d360=' + (f(59)>>>0) +
            ' ring=[' + [60,61,62,63,64,65,66,67].map(function(c){return h(f(c));}).join(',') + ']' +
            ' credit=' + (f(68)>>>0) + ' srC=0x' + h(f(69)) + ' pendC=0x' + h(f(70)) + ' istC=0x' + h(f(71)) + ' pcC=0x' + h(f(72)) + ' schedN=' + (f(73)|0) +
            // Lever-4 [smc]: icgen delta/s = total IC-invalidation rate; smcS/B/R
            // split it by writer (slow store / block-DMA / re-register); cpg =
            // marked code pages.
            ' icgen=' + (f(74)>>>0) + ' smcS=' + (f(75)>>>0) + ' smcB=' + (f(76)>>>0) + ' smcR=' + (f(77)>>>0) + ' cpg=' + (f(78)>>>0) + ' smcT=' + (f(79)>>>0) + ' smcA=0x' + h(f(80)) + ' syncsr=' + (f(81)>>>0) + ' shms=' + (f(82)>>>0) + ' rrms=' + (f(83)>>>0) + ' ftrv=' + (f(84)>>>0) + ' fipr=' + (f(85)>>>0) + ' fsca=' + (f(86)>>>0) + ' ifbo=' + (f(87)>>>0) + ' icn=' + (f(88)>>>0) });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[ctxsnap] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'peek': {
        try {
          const groups = data.groups || [];
          for (const g of groups) {
            const a = g.addr >>> 0, n = (g.count >>> 0) || 1;
            const out = [];
            for (let k = 0; k < n; k++)
              out.push(('0000000' + ((Module._sh4_mem_read32(a + k * 4) >>> 0).toString(16))).slice(-8));
            postMessage({ cmd: 'print', txt: '[peek] 0x' + a.toString(16) + ' = ' + out.join(' ') });
          }
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[peek] threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      default:
        postMessage({ cmd: 'print', txt: '[flycast-shim] unknown cmd: ' + data.cmd });
    }
  }
})();
