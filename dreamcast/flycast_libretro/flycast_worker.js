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
    importScripts('/gamecube/seqlock.js');
    importScripts('/gamecube/ringbuffer.js');
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
        const moduleArg = {
          wasmMemory: sharedMemory,
          locateFile: function (f) { return new URL(f, self.location.href).href; },
          // Pthread spawn uses _scriptName by default → our shim. Force the
          // factory URL instead so pthread workers load the emcc bootstrap.
          mainScriptUrlOrBlob: new URL('flycast_worker_emcc.js', self.location.href).href,
          print:       function (s) { postMessage({ cmd: 'print', txt: '[wasm.out] ' + s }); },
          printErr:    function (s) { postMessage({ cmd: 'print', txt: '[wasm.err] ' + s }); },
          onAbort: function (why) { postMessage({ cmd: 'print', txt: '[flycast-shim] ABORT: ' + why }); },
        };
        flycastWorkerModule(moduleArg).then(
          function (mod) {
            // mod IS moduleArg post-mutation, with all _emscripten_* exports.
            self.Module = mod;
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
  function onCmd(e) {
    const Module = self.Module;
    const data = (e && e.data) || {};
    switch (data.cmd) {
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
        try {
          Module._emscripten_run_iter();
          postMessage({ cmd: 'frame' });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] run_iter threw: ' + (err && err.message ? err.message : String(err)) });
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
          Module._emscripten_reset();
          postMessage({ cmd: 'print', txt: '[flycast-shim] reset done' });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] reset threw: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'saveState': {
        try {
          const ppOut  = Module._malloc(4);
          const ppSize = Module._malloc(4);
          const ok = Module._emscripten_save_state(ppOut, ppSize);
          if (!ok) {
            Module._free(ppOut); Module._free(ppSize);
            postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) });
            break;
          }
          const bufPtr = Module.HEAPU32[ppOut >>> 2];
          const size   = Module.HEAPU32[ppSize >>> 2];
          const out = new Uint8Array(Module.HEAPU8.subarray(bufPtr, bufPtr + size));
          // The bridge mallocs the buffer; we own freeing it.
          Module._free(bufPtr);
          Module._free(ppOut); Module._free(ppSize);
          postMessage({ cmd: 'stateSaved', data: out }, [out.buffer]);
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] saveState threw: ' + (err && err.message ? err.message : String(err)) });
          postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) });
        }
        break;
      }

      case 'loadState': {
        try {
          const src = data.data ? new Uint8Array(data.data) : new Uint8Array(0);
          const ptr = Module._malloc(src.length);
          Module.HEAPU8.set(src, ptr);
          const ok = Module._emscripten_load_state(ptr, src.length);
          Module._free(ptr);
          postMessage({ cmd: 'stateLoaded', success: !!ok });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] loadState threw: ' + (err && err.message ? err.message : String(err)) });
          postMessage({ cmd: 'stateLoaded', success: false });
        }
        break;
      }

      default:
        postMessage({ cmd: 'print', txt: '[flycast-shim] unknown cmd: ' + data.cmd });
    }
  }
})();
