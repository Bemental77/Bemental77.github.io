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
  // The block-gzip disc reader, the SAME file dreamcast.html loads. It is not
  // optional the way the SAB primitives are: without it a .bgz disc cannot be
  // streamed at all, so 'discLazy' reports the failure rather than quietly
  // falling through to arithmetic that would read compressed bytes as disc
  // bytes. Kept as its own try so an import failure is attributable.
  try {
    importScripts('/lib/bgz.js');
  } catch (e) {
    postMessage({ cmd: 'print', txt: '[flycast-shim] /lib/bgz.js import FAILED: ' + e +
                  ' — block-compressed discs cannot stream' });
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
      // The framebuffer and audio ring used to sit at page-chosen FIXED
      // addresses near 496 MB, which is the ONLY reason the heap had to be
      // 512 MB up front — a commit that alone can kill a low-RAM phone.
      // Allocate them from the heap instead and report the addresses back:
      // malloc'd pointers are stable across memory growth, so the heap can now
      // start small and grow to whatever the emulator actually needs.
      const fbBytes = (fbCfg.w | 0) * (fbCfg.h | 0) * 4;
      const audioBytes = (audioCfg.frames | 0) * 2 * 4 + 64;   // stereo f32 + header
      const fbAddr = Module._malloc(fbBytes);
      const audioAddr = Module._malloc(audioBytes);
      if (!fbAddr || !audioAddr) throw new Error('framebuffer/audio alloc failed');
      Module.HEAPU8.fill(0, audioAddr, audioAddr + audioBytes);
      Module._emscripten_set_video_target(fbAddr >>> 0, fbCfg.w | 0, fbCfg.h | 0);
      Module._emscripten_set_audio_ring(audioAddr >>> 0, audioCfg.frames | 0);
      postMessage({ cmd: 'sabLayout', fbOffset: fbAddr >>> 0, fbW: fbCfg.w | 0,
                    fbH: fbCfg.h | 0, audioOffset: audioAddr >>> 0,
                    audioFrames: audioCfg.frames | 0 });
      postMessage({ cmd: 'print', txt: '[flycast-shim] fb=' + (fbAddr >>> 0) +
                    ' audio=' + (audioAddr >>> 0) + ' (heap-allocated)' });
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
  // Lazy-disc telemetry: how much of the 1.18GB a session actually touches —
  // the number that decides whether streaming is viable on a phone.
  const lazyStats = { hits: 0, misses: 0, bytes: 0, evicted: 0, ahead: 0 };
  let lazyReported = -1;
  function lazyPoll() {
    if (lazyStats.misses === lazyReported) return;
    lazyReported = lazyStats.misses;
    postMessage({ cmd: 'print', txt: '[lazydisc] fetched=' +
      ((lazyStats.bytes / 1048576) | 0) + 'MB chunks=' + lazyStats.misses +
      ' cachehits=' + lazyStats.hits + ' readahead=' + lazyStats.ahead +
      ' evicted=' + lazyStats.evicted });
  }

  // VMU change-watch (see the vmuLoad/vmuWatch handlers).
  //
  // ⚠ ONE CARD PER MAPLE PORT — 0..3, i.e. Player 1..4. This used to be a
  // single scalar pair because the core only published one pointer, so a
  // two-player console had two memory cards inside it and the page could see
  // exactly one: player 2 saved, the guest wrote the card, and the bytes died
  // with the tab. The core now publishes per bus (maple_devs.cpp) and these
  // accessors take a port, so each seat is seeded and snapshotted on its own.
  const VMU_PORTS_MAX = 4;   // == MAPLE_PORTS; the real count is read from the core
  let vmuWatch = false;
  let vmuPortCount = 0;
  const vmuGenSeen = [-1, -1, -1, -1];
  function vmuPortsFromCore() {
    const M = self.Module;
    if (!M) return 0;
    // Ask the binary rather than assume: a shim newer than its .wasm would
    // otherwise index cards that build has no accessor for.
    if (typeof M._flycast_vmu_ports === 'function') {
      const n = M._flycast_vmu_ports() | 0;
      return n > 0 && n <= VMU_PORTS_MAX ? n : 0;
    }
    return 0;
  }
  function vmuPoll() {
    if (!vmuWatch) return;
    const M = self.Module;
    if (!M || typeof M._flycast_vmu_gen !== 'function') return;
    if (!vmuPortCount) vmuPortCount = vmuPortsFromCore();
    const n = vmuPortCount || 1;
    for (let port = 0; port < n; port++) {
      const gen = M._flycast_vmu_gen(port) >>> 0;
      if (gen === vmuGenSeen[port]) continue;
      const ptr = M._flycast_vmu_ptr(port) >>> 0, size = M._flycast_vmu_size(port) >>> 0;
      // An empty slot (no controller on that bus) reports 0/0. Do NOT bank the
      // generation in that case — the card may still be created later, and
      // swallowing the bump would lose its first snapshot.
      if (!ptr || !size) continue;
      vmuGenSeen[port] = gen;
      const copy = new Uint8Array(M.HEAPU8.subarray(ptr, ptr + size));  // detached copy
      postMessage({ cmd: 'vmuChanged', port: port, data: copy, gen: gen }, [copy.buffer]);
    }
  }
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
  // ---------------------------------------------------------------------------
  // Duty-cycle telemetry (2026-08-28). THE TWO KNOBS ARE SEPARATE:
  //
  //   GUEST RATE      — set here, by the governor below. Target 1.000x = the
  //                     real SH4 clock. Nothing else in the page may move it.
  //   PRESENTED RATE  — set by the GAME. One present = one
  //                     emscripten_webgl_commit_frame() from video_cb in
  //                     EmscriptenWorker.cpp, i.e. one DISTINCT guest frame.
  //                     PSO Ver.2 renders every other DC VBlank, so at 1.000x
  //                     it is 30/s by design (native flycast: R: 29.72).
  //
  // Headroom ("how far ahead of the hardware are we?") is only knowable HERE,
  // because the surplus is the wall time this governor GIVES BACK — it never
  // shows up in either rate. So partition each wall second:
  //     busy  = time inside _emscripten_run_iter()
  //     paced = the delay we deliberately inserted to stay at 1.000x
  //     (remainder: scheduler latency + asyncify-suspend waits — charged to
  //      NEITHER, which makes the reported headroom a floor, never a boast)
  // The page turns (busy, paced, wall) into duty, cost-per-produced-frame and
  // headroom. Cost: two performance.now() reads per iteration, one of which
  // replaces the governor's own read.
  // ---------------------------------------------------------------------------
  let paceBusyMs = 0, pacePacedMs = 0, paceWindowStart = 0;
  function resetPace() {
    paceBaseWall = 0; paceBaseCyc = 0;
    // A rebase (uncap toggle, reset, savestate load) starts a fresh duty
    // window too — a duty number straddling two arms describes neither.
    paceBusyMs = 0; pacePacedMs = 0; paceWindowStart = performance.now();
  }
  // ---------------------------------------------------------------------------
  // LOCKSTEP PUMP (2026-09-08). Online play used to mean ONE emulator: the host
  // ran the game and shipped an encoded picture to player 2, whose every button
  // cost a network round trip plus an encode plus a decode. Player 2 was
  // watching. Under lockstep BOTH machines run a core and only pad bytes cross
  // the wire, so each player's own input is local — which is what a console
  // does.
  //
  // WHAT CHANGES HERE, AND WHAT MUST NOT. Exactly one thing changes: the pump
  // will not start emulated frame N until it HOLDS the pad state for frame N,
  // for both players. Everything else — the real-time governor, the asyncify
  // boundary rules, the crash decode — is untouched, and with lockstep off
  // (the default, and every single-player session) pumpTick runs the identical
  // path it ran before.
  //
  // ⚠ THE GUEST RATE IS NOT A KNOB HERE. The governor still paces the core to
  // 1.000x the real SH4 clock; lockstep can only make the guest run SLOWER than
  // that (a stall), never faster. In particular a stall is NOT repaid: the
  // governor is rebased while gated, so the core never sprints to catch up.
  // Time lost to a stall stays lost, which is correct — both machines lost it.
  //
  // ⚠ AND IT NEVER GUESSES. A missing input stalls. Substituting a plausible
  // pad value would fork the two machines silently and permanently.
  // ---------------------------------------------------------------------------
  let discLoadedOnce = false;   // so a late 'players' is REPORTED, not ignored
  let lockstep = false;
  let lsFrame = 0;                  // next emulated frame to run
  // CARDS THAT MUST BE (RE)INSTALLED AT AN EXACT FRAME, NOT "SOON".
  //
  // On a seeded disc the boot savestate was captured when this console had ONE
  // memory card. A room attaches one per player, so the port that was not in
  // the state gets re-initialised by the guest during its first frames and
  // player 2's card is replaced by a blank one. Measured: port 1 reads the
  // right card (b19a59c5) BEFORE frame 0 on both machines and reads zeros
  // afterwards, at the SAME pointer — an in-place overwrite by the guest, not a
  // reallocation. On the unseeded disc the identical exchange survives, which
  // is what identifies the savestate as the cause.
  //
  // Re-installing "once things settle" would be a fork: two consoles writing
  // guest-visible memory at two different frames is exactly the divergence
  // lockstep exists to prevent. So the write is scheduled at a FRAME NUMBER and
  // performed by the frame loop below, which makes it identical on every
  // console by construction.
  const vmuAtFrame = [];            // { port, data, atFrame }
  let lsQueue = new Map();          // frame -> Uint8Array(256) maple image
  let lsHashEvery = 60;
  let lsPendingHash = -1;           // frame whose fingerprint is owed, -1 = none
  let lsStallSince = 0, lsStallSpin = 0;
  const lsStats = { frames: 0, stalls: 0, stallMs: 0, maxStallMs: 0, queued: 0, dropped: 0 };

  // The fingerprint. Every word is a COMMITTED SH4/Holly field read through
  // flycast_ctx_snapshot, which is already exported by the shipped binary
  // (flycast_worker_link.sh:86) — this needs no core rebuild.
  //   0 pc   1 sr   2 interrupt_pend   3 cycle_counter   4 sh4_sched_next
  //   5 CpuRunning   6 vbr   7 SB_ISTNRM   8 SB_IML6NRM   9 spc  10 ssr  11 pr
  // plus the 64-bit guest cycle counter, split.
  // ⚠ ONLY VALID AT A CLEAN ASYNCIFY BOUNDARY. Read mid-suspend these are stale
  // (the shim's own ?ctxsnap note says so), and a stale fingerprint compared
  // against a committed one is a FALSE DESYNC. Every caller below checks
  // runIterSuspended() first and REFUSES rather than returning a bad reading.
  function lsWords() {
    const M = self.Module;
    const w = [];
    if (typeof M._flycast_ctx_snapshot === 'function') {
      for (let i = 0; i <= 11; i++) w.push(M._flycast_ctx_snapshot(i) >>> 0);
    }
    if (typeof M._flycast_guest_cycles === 'function') {
      const c = M._flycast_guest_cycles();
      w.push(c >>> 0, Math.floor(c / 4294967296) >>> 0);
    }
    return w;
  }
  function lsHash(words) {
    let h = 0x811c9dc5;
    for (let i = 0; i < words.length; i++) {
      h = (h ^ (words[i] >>> 0)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  // The maple image is 4 ports x 64 B = 256 B (EmscriptenWorker.cpp:112). A
  // longer buffer would run off the end of it into whatever follows.
  const MAPLE_BYTES = 256;
  function lsWritePads(u8) {
    const M = self.Module;
    const ptr = M._emscripten_get_maple_ptr() >>> 0;
    if (!ptr) return false;
    M.HEAPU8.set(u8.length > MAPLE_BYTES ? u8.subarray(0, MAPLE_BYTES) : u8, ptr);
    return true;
  }

  const pumpChannel = new MessageChannel();
  pumpChannel.port1.onmessage = pumpTick;
  // ⚠ AT MOST ONE PENDING TICK, EVER. Posting to port2 queues a macrotask that
  // runs a frame; nothing used to stop several from being queued at once, and
  // then the governor's setTimeout was scheduling one more tick BEHIND a stack
  // of ticks that were already due. Measured: handing the lockstep queue 480
  // frames at once made every one of them kick the pump, and the core ran the
  // entire backlog in under 600 ms — >800 fps, a 13x guest speed-up, which is
  // precisely the thing that must never happen (CLAUDE.md gate #9). The kick is
  // now idempotent: a tick already on its way absorbs any further request.
  let pumpQueued = false;
  function pumpKick(ms) {
    if (pumpQueued) return;
    pumpQueued = true;
    if (ms > 1) setTimeout(() => pumpChannel.port2.postMessage(0), ms);
    else pumpChannel.port2.postMessage(0);
  }

  // ---------------------------------------------------------------------------
  // C++ THROW DECODER.  A crash report that says
  //     "freerun run_iter threw (pump stopped): [object Object] sh4_pc=0x..."
  // names NOTHING.  The link is `-fexceptions` (JS-based emscripten EH, see
  // flycast-bridge/flycast_worker_link.sh:346), so a C++ throw arrives in JS as
  // a `CppException` — a class whose ONLY field is `excPtr`
  // (flycast_worker_emcc.js:452-457).  It has no `.message` and no `.stack`,
  // which is exactly why `String(err)` degrades to `[object Object]` and why the
  // shim's `stack=` suffix was absent from the field report.  That is a
  // *formatting* dead end, not a missing signal: everything is reachable from
  // excPtr.
  //
  //   type      = HEAPU32[(excPtr - 24 + 4) >> 2]     ExceptionInfo.get_type()
  //               (flycast_worker_emcc.js:1365-1376 — the metadata header sits
  //                24 bytes BELOW the thrown object)
  //   mangled   = C string at HEAPU32[(type + 4) >> 2]
  //               (Itanium type_info: vptr, then const char* __type_name)
  //   message   = C string at HEAPU32[(excPtr + 4) >> 2] for anything derived
  //               from std::runtime_error (libc++ __libcpp_refstring holds a
  //               bare char* at offset 0 of the runtime_error subobject).
  //               FlycastException IS one — core/types.h:231.
  //
  // Verified against the SHIPPED binary: `16FlycastException` and
  // `18SH4ThrownException` are both present in flycast_worker_emcc.wasm, so the
  // RTTI names survive the release link and this decode has something to read.
  // Every step is bounds-checked and the whole thing is wrapped — a decoder
  // that throws while decoding a crash would erase the crash.
  // ---------------------------------------------------------------------------
  function cstr(u8, p, max) {
    if (!(p > 0) || p >= u8.length) return '';
    let s = '';
    for (let i = 0; i < max && p + i < u8.length; i++) {
      const c = u8[p + i];
      if (c === 0) break;
      s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '?';
    }
    return s;
  }
  function describeThrow(Module, err) {
    // Non-C++ throws (wasm traps, RangeError, ...) already stringify usefully.
    if (!err || typeof err !== 'object' || !('excPtr' in err)) {
      return (err && err.message) ? err.message : String(err);
    }
    let out = 'C++ throw';
    try {
      const u8 = Module.HEAPU8, u32 = Module.HEAPU32;
      const excPtr = err.excPtr >>> 0;
      out += ' excPtr=0x' + excPtr.toString(16);
      const type = (excPtr >= 24) ? (u32[(excPtr - 20) >> 2] >>> 0) : 0;
      const name = type ? cstr(u8, u32[(type + 4) >> 2] >>> 0, 96) : '';
      if (name) out += ' type=' + name;
      // std::runtime_error-derived: the what() string is one indirection in.
      const msg = cstr(u8, u32[(excPtr + 4) >> 2] >>> 0, 160);
      if (msg) out += ' what="' + msg + '"';
    } catch (e) {
      out += ' (decode failed: ' + e + ')';
    }
    return out;
  }
  // Guest-CPU state at the moment the throw escaped. flycast_ctx_snapshot is
  // EXPORTED IN THE SHIPPED BINARY (rec_wasm.cpp:1072) and cases 0-11 are plain
  // Sh4cntx field reads, so this costs nothing and is available on any deploy.
  // SR bit 28 is BL (exception-blocked); Do_Exception throws
  // FlycastException("Fatal: SH4 exception when blocked") when it is set
  // (core/hw/sh4/sh4_interrupts.cpp:222-223), so SR is the field that
  // discriminates that path from every other escape.
  // NOTE: ctx_snapshot cases 60-67 read g_pc_ring, which NOTHING WRITES
  // (grepped: rec_wasm.cpp declares it and only ever reads it) — they return 0
  // and are deliberately not sampled here.
  // Guest memory around the fault, read through the SAME export the ?peek
  // command uses (Module._sh4_mem_read32, flycast_worker.js case 'peek'). The
  // question a "pump stopped" report cannot answer on its own is "what code was
  // the guest about to run, and what does its exception vector hold" — both are
  // one read away and neither survives the tab closing.
  function dumpGuest(Module, label, addr, words) {
    try {
      if (typeof Module._sh4_mem_read32 !== 'function') return;
      const a = addr >>> 0, out = [];
      for (let k = 0; k < words; k++) {
        let v;
        try { v = Module._sh4_mem_read32(a + k * 4) >>> 0; } catch (_) { v = 0xBADA5510; }
        out.push(('0000000' + v.toString(16)).slice(-8));
      }
      postMessage({ cmd: 'print', txt: '[crash-mem] ' + label + ' 0x' + a.toString(16) + ': ' + out.join(' ') });
    } catch (_) {}
  }
  function dumpCrashContext(Module) {
    try {
      const g = (i) => Module._flycast_ctx_snapshot(i) >>> 0;
      const pc = (typeof Module._flycast_get_sh4_pc === 'function') ? (Module._flycast_get_sh4_pc() >>> 0) : 0;
      const vbr = g(6), spc = g(9), pr = g(11);
      dumpGuest(Module, 'pc-16',      (pc - 16) >>> 0, 12);
      dumpGuest(Module, 'ram+0',      0x8c000000, 12);
      // The general-exception handler is the code that decides where the guest
      // goes after the FIRST fault, so it is dumped long enough to disassemble.
      for (let i = 0; i < 6; i++)
        dumpGuest(Module, 'vbr+0x100+' + (i * 32), (vbr + 0x100 + i * 32) >>> 0, 8);
      dumpGuest(Module, 'vbr+0x400',  (vbr + 0x400) >>> 0, 8);
      dumpGuest(Module, 'vbr+0x600',  (vbr + 0x600) >>> 0, 8);
      dumpGuest(Module, 'pr-16',      (pr - 16) >>> 0, 8);
      dumpGuest(Module, 'spc-16',     (spc - 16) >>> 0, 8);
      // CCN: EXPEVT holds the code of the exception that was actually VECTORED
      // (Do_Exception throws before it writes CCN_EXPEVT, so this is fault #1,
      // not the fatal one). INTEVT/TRA round out the CPU's own account.
      dumpGuest(Module, 'CCN EXPEVT/INTEVT', 0xFF000024, 2);
      dumpGuest(Module, 'CCN TRA',          0xFF000020, 1);
    } catch (_) {}
  }
  function sh4StateLine(Module) {
    try {
      if (typeof Module._flycast_ctx_snapshot !== 'function') return '';
      const g = (i) => (Module._flycast_ctx_snapshot(i) >>> 0).toString(16);
      const sr = Module._flycast_ctx_snapshot(1) >>> 0;
      return ' sr=0x' + sr.toString(16) + ' BL=' + ((sr >>> 28) & 1) +
             ' MD=' + ((sr >>> 30) & 1) +
             ' spc=0x' + g(9) + ' ssr=0x' + g(10) + ' pr=0x' + g(11) +
             ' vbr=0x' + g(6) + ' pend=0x' + g(2) + ' run=' + g(5);
    } catch (_) { return ''; }
  }

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
    pumpQueued = false;
    if (!freerun) return;
    const Module = self.Module;
    if (runIterSuspended()) {
      // Let the suspended frame's own timer rewind and finish; check back.
      pumpKick(4);
      return;
    }
    // Clean asyncify boundary (run_iter is NOT suspended): the only safe point to
    // serialize. Saving from the message handler while a frame is asyncify-suspended
    // corrupts the frame, so the next run_iter unwinds and the pump freezes — which
    // is what made Save State "break". Do the deferred save here instead.
    if (pendingSave) { pendingSave = false; doSaveState(); }
    // ---- LOCKSTEP GATE ------------------------------------------------------
    // We are at a clean asyncify boundary here, which is the only place the
    // fingerprint of the frame we just finished can be read honestly.
    if (lockstep) {
      if (lsPendingHash >= 0) {
        const f = lsPendingHash; lsPendingHash = -1;
        const w = lsWords();
        postMessage({ cmd: 'lsHash', f, h: lsHash(w), w });
      }
      const inp = lsQueue.get(lsFrame);
      if (!inp) {
        // STALL. The other player's input for this frame has not arrived, so
        // this machine does not advance. The picture holds, the audio ring
        // drains, and the page is told so it can say WHY rather than look hung.
        if (!lsStallSince) {
          lsStallSince = performance.now(); lsStallSpin = 0; lsStats.stalls++;
          postMessage({ cmd: 'lsStall', f: lsFrame, on: 1 });
        }
        // The governor must not remember this gap: rebasing here is what stops
        // the core sprinting through the backlog when input arrives.
        paceBaseWall = 0; paceBaseCyc = 0;
        // Re-check immediately for the first few tries — most stalls are a
        // fraction of a frame and a 4 ms timer clamp would turn every one of
        // them into 4 ms of added latency. Fall back to a timer after that so a
        // long stall is not a hot spin.
        pumpKick(lsStallSpin++ < 8 ? 0 : 1);
        return;
      }
      if (lsStallSince) {
        const d = performance.now() - lsStallSince;
        lsStallSince = 0;
        lsStats.stallMs += d;
        if (d > lsStats.maxStallMs) lsStats.maxStallMs = d;
        postMessage({ cmd: 'lsStall', f: lsFrame, on: 0, ms: Math.round(d) });
      }
      lsQueue.delete(lsFrame);
      lsWritePads(inp);
    }
    // Apply any card scheduled for THIS frame, before the frame runs. Every
    // console reaches this frame with the same bytes, so the write is part of
    // the deterministic timeline rather than a race against it.
    if (vmuAtFrame.length && lockstep) {
      for (let i = vmuAtFrame.length - 1; i >= 0; i--) {
        if (vmuAtFrame[i].atFrame !== lsFrame) continue;
        const job = vmuAtFrame.splice(i, 1)[0];
        try {
          const M = self.Module;
          const ptr = M._flycast_vmu_ptr(job.port) >>> 0, size = M._flycast_vmu_size(job.port) >>> 0;
          const src = new Uint8Array(job.data);
          if (!ptr || !size || src.length !== size) {
            postMessage({ cmd: 'print', txt: '[vmu] port ' + job.port + ': frame-' + job.atFrame +
                          ' re-install skipped (ptr=' + ptr + ' size=' + size + ' src=' + src.length + ')' });
            postMessage({ cmd: 'vmuSeeded', port: job.port, ok: false, why: 'no card or size mismatch at frame' });
            continue;
          }
          M.HEAPU8.set(src, ptr);
          vmuGenSeen[job.port] = M._flycast_vmu_gen(job.port) >>> 0;
          postMessage({ cmd: 'print', txt: '[vmu] port ' + job.port + ': re-installed ' + size +
                        ' B at frame ' + job.atFrame + ' — the boot state had replaced it' });
          postMessage({ cmd: 'vmuSeeded', port: job.port, ok: true, atFrame: job.atFrame });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[vmu] port ' + job.port + ': frame re-install threw: ' +
                        (err && err.message ? err.message : String(err)) });
        }
      }
    }
    const t0 = performance.now();
    try {
      Module._emscripten_run_iter();
      freerunIters++;
      if (lockstep) {
        const f = lsFrame++;
        lsStats.frames++;
        // The page needs to know a frame completed so it can produce the input
        // for f + delay. It is the frame clock for the whole session.
        postMessage({ cmd: 'lsFrame', f });
        // The fingerprint is deferred to the NEXT tick's clean boundary — see
        // lsWords(). Reading it here can catch a suspended frame.
        if (lsHashEvery > 0 && (f % lsHashEvery) === 0) lsPendingHash = f;
      }
    } catch (err) {
      freerun = false;
      if (freerunStatsTimer) { clearInterval(freerunStatsTimer); freerunStatsTimer = 0; }
      var pcTxt = '';
      try { if (Module._flycast_get_sh4_pc) pcTxt = ' sh4_pc=0x' + (Module._flycast_get_sh4_pc() >>> 0).toString(16); } catch (_) {}
      var stk = (err && err.stack) ? (' stack=' + String(err.stack).split('\n').slice(0, 4).join(' | ')) : '';
      postMessage({ cmd: 'print', txt: '[flycast-shim] freerun run_iter threw (pump stopped): ' +
        describeThrow(Module, err) + pcTxt + sh4StateLine(Module) + stk });
      dumpCrashContext(Module);
      return;
    }
    // Wall time actually spent emulating. Taken once, and reused as the
    // governor's "now" below (it was calling performance.now() here anyway).
    const t1 = performance.now();
    paceBusyMs += t1 - t0;
    let delay = 0;
    if (!uncap && typeof Module._flycast_guest_cycles === 'function') {
      // Governor: schedule the next iteration so guest time never leads wall
      // time. A large desync in either direction (background tab, level load,
      // state jump — the cycle counter jumps on unserialize) rebases instead
      // of sprinting or stalling to catch up.
      const nowW = t1;
      const cyc = Module._flycast_guest_cycles();
      if (!paceBaseWall) { paceBaseWall = nowW; paceBaseCyc = cyc; }
      const lead = (cyc - paceBaseCyc) / SH4_HZ * 1000 - (nowW - paceBaseWall);
      if (lead < -250 || lead > 250) { paceBaseWall = nowW; paceBaseCyc = cyc; }
      else delay = Math.max(0, Math.min(50, lead));
    } else {
      // uncap: TRUE free-run (lever-11 rig fix, 2026-08-28). The historical
      // `FRAME_MS - elapsed` limiter here silently capped "uncapped" probes
      // at 60 iters/s — clk saturated at ~59 x 6.6M ≈ 390-400MHz for ANY
      // sufficiently fast build, which is exactly where the lever ladder
      // plateaued (lever-8/9C/9D nulls measured against this rig ceiling,
      // 2.4% idle at baseline vs 34% idle under lever-11 idleskip, iters
      // pinned at 59/s in both). Perf probes must see the CPU, not the rig.
      delay = 0;
    }
    // Only the delay we ASKED for counts as given-back time. setTimeout
    // overshoot lands in the unattributed remainder, so headroom stays a floor.
    if (delay > 1) { pacePacedMs += delay; pumpKick(delay); }
    else pumpKick(0);
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
      paceBusyMs = 0; pacePacedMs = 0; paceWindowStart = performance.now();
      freerunStatsTimer = setInterval(() => {
        // ips is unchanged (probes parse it). busy/paced/wall are additive —
        // an older page that ignores them still reads iters/s exactly as before.
        const nowW = performance.now();
        const wallMs = paceWindowStart ? (nowW - paceWindowStart) : 0;
        postMessage({ cmd: 'ips', ips: freerunIters,
                      busyMs: Math.round(paceBusyMs),
                      pacedMs: Math.round(pacePacedMs),
                      wallMs: Math.round(wallMs),
                      governed: uncap ? 0 : 1 });
        paceWindowStart = nowW; paceBusyMs = 0; pacePacedMs = 0;
        freerunIters = 0;
        vmuPoll();   // card snapshots ride the existing 1 Hz tick
        lazyPoll();
      }, 1000);
      postMessage({ cmd: 'print', txt: '[flycast-shim] freerun ON (worker-owned run loop, real-time governor ' +
                                       (uncap ? 'OFF — ?uncap arm, guest UNGOVERNED' : 'ON — guest paced to 1.000x') + ')' });
      pumpKick(0);
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
      // ?uncap=1 is a MEASUREMENT ARM, never a shipping configuration: it
      // removes the governor, so the GUEST runs fast (the games are sped up).
      // It is not, and must never become, the way the page reaches a higher
      // presented rate — see the two-knobs comment above resetPace().
      case 'uncap':
        uncap = !!data.on;
        resetPace();
        postMessage({ cmd: 'print', txt: '[pump] uncap=' + (uncap ? 1 : 0) + ' (real-time governor ' +
                     (uncap ? 'OFF — MEASUREMENT ARM, guest is NOT at 1.000x' : 'ON — guest paced to 1.000x') + ')' });
        break;
      // ---- LOCKSTEP ---------------------------------------------------------
      // Turning it on does NOT start the game: the pump immediately gates on an
      // empty queue and stalls until the page feeds frame 0. That is deliberate
      // — a lockstep session must not run one frame before both machines have
      // agreed on where they are starting from.
      case 'lockstep': {
        const on = !!data.on;
        if (on === lockstep) { postMessage({ cmd: 'lsState', on: lockstep ? 1 : 0, f: lsFrame }); break; }
        lockstep = on;
        lsQueue.clear();
        lsFrame = data.frame | 0;
        lsPendingHash = -1;
        lsStallSince = 0;
        lsHashEvery = data.hashEvery == null ? 60 : (data.hashEvery | 0);
        lsStats.frames = 0; lsStats.stalls = 0; lsStats.stallMs = 0;
        lsStats.maxStallMs = 0; lsStats.queued = 0; lsStats.dropped = 0;
        resetPace();
        postMessage({ cmd: 'print', txt: '[lockstep] ' + (on
          ? 'ON — the core advances one frame per delivered input pair, governor still 1.000x'
          : 'OFF — free-run governor resumed') + ' frame=' + lsFrame + ' hashEvery=' + lsHashEvery });
        postMessage({ cmd: 'lsState', on: lockstep ? 1 : 0, f: lsFrame });
        // Kick the pump so an ON while already free-running takes effect at once.
        if (freerun) pumpKick(0);
        break;
      }
      // One frame's input: the full 256-byte maple image (4 ports x 64 B),
      // exactly the layout case 'input' already uses. Both players' pads are in
      // it, because under lockstep every machine writes every pad.
      case 'lsInput': {
        if (!data.states) break;
        const f = data.f | 0;
        if (f < lsFrame) { lsStats.dropped++; break; }   // already run; cannot un-run it
        lsQueue.set(f, new Uint8Array(data.states));
        lsStats.queued++;
        // ⚠ ONLY the frame the pump is actually parked on may un-park it.
        // Kicking on EVERY queued input is what let a 480-frame backlog queue
        // 480 pump ticks and sprint the guest through all of them.
        if (lockstep && freerun && lsStallSince && f === lsFrame) pumpKick(0);
        break;
      }
      // THE DETERMINISM HANDSHAKE, once per peer at ROOM START — after the disc
      // has loaded and BEFORE the first lockstep frame. Without it two fresh
      // boots reach a frame-0 anchor that is byte-identical across all
      // 27,785,287 bytes and still diverge at 125-295 of 424 chunks: something
      // the machine DERIVES AND CACHES rather than stores differs between two
      // boots, and retro_serialize cannot see it.
      // `emscripten_lockstep_normalize` (EmscriptenWorker.cpp) serializes this
      // instance and loads its OWN bytes straight back — the state is unchanged
      // by construction and the POINT is retro_unserialize's
      // emu.stop()/loadstate/emu.start(), which rebuilds it — with the JIT
      // flush on BOTH sides of the round trip. Measured on the frame-0 path:
      // flush alone 0/3, round-trip alone 0/3, both 3/3 BYTE-IDENTICAL over
      // 1800 frames (commit 9d16f261).
      // ⚠ REFUSES mid-suspend rather than corrupting the frame, the same rule
      // the deferred save follows.
      case 'lsNormalize': {
        if (typeof self.Module._emscripten_lockstep_normalize !== 'function') {
          postMessage({ cmd: 'lsNormalize', ok: false,
                        error: 'this build does not export _emscripten_lockstep_normalize — relink' });
          break;
        }
        if (runIterSuspended()) {
          postMessage({ cmd: 'lsNormalize', ok: false,
                        error: 'a frame is asyncify-suspended — normalizing here would corrupt it' });
          break;
        }
        try {
          const t0 = performance.now();
          const ok = self.Module._emscripten_lockstep_normalize() | 0;
          const ms = Math.round(performance.now() - t0);
          postMessage({ cmd: 'print', txt: '[lockstep] normalize ' + (ok ? 'OK' : 'FAILED') + ' in ' + ms + ' ms' });
          postMessage({ cmd: 'lsNormalize', ok: !!ok, ms,
                        error: ok ? null : 'emscripten_lockstep_normalize returned 0 (no disc loaded, or serialize failed)' });
        } catch (err) {
          postMessage({ cmd: 'lsNormalize', ok: false, error: (err && err.message) ? err.message : String(err) });
        }
        break;
      }
      // The fingerprint, on demand — this is what proves the two machines start
      // identical (and, at the end, what a bug report should carry).
      // ⚠ REFUSES rather than reporting a stale reading mid-suspend.
      case 'lsFingerprint': {
        if (runIterSuspended()) {
          postMessage({ cmd: 'lsFingerprint', ok: false, f: lsFrame,
                        error: 'a frame is asyncify-suspended — the fingerprint would be stale' });
          break;
        }
        try {
          const w = lsWords();
          postMessage({ cmd: 'lsFingerprint', ok: w.length > 0, f: lsFrame, w, h: lsHash(w),
                        error: w.length ? null : 'flycast_ctx_snapshot is not exported by this build' });
        } catch (err) {
          postMessage({ cmd: 'lsFingerprint', ok: false, f: lsFrame,
                        error: (err && err.message) ? err.message : String(err) });
        }
        break;
      }
      case 'lsStats': {
        postMessage({ cmd: 'lsStats', on: lockstep ? 1 : 0, f: lsFrame,
                      queued: lsQueue.size, frames: lsStats.frames, stalls: lsStats.stalls,
                      stallMs: Math.round(lsStats.stallMs), maxStallMs: Math.round(lsStats.maxStallMs),
                      accepted: lsStats.queued, dropped: lsStats.dropped });
        break;
      }
      // HOW MANY CONTROLLERS TO PRESENT. One per player in the room.
      // ⚠ MUST ARRIVE BEFORE 'discReady'/'discLazy' — the devices are created
      // inside retro_load_game and this build does not hotplug (see the
      // g_player_ports block in EmscriptenWorker.cpp for why). Sending it late
      // is reported rather than silently ignored, because a room that quietly
      // ran with the wrong number of pads is a desync between machines.
      case 'players': {
        const n = Math.max(1, Math.min(4, data.n | 0));
        try {
          if (typeof Module._emscripten_set_player_ports !== 'function') {
            postMessage({ cmd: 'print', txt: '[players] REFUSED — this build has no _emscripten_set_player_ports; relink' });
            postMessage({ cmd: 'players', ok: false, n: 0, late: false, error: 'export missing' });
            break;
          }
          Module._emscripten_set_player_ports(n);
          const got = Module._emscripten_get_player_ports() >>> 0;
          const late = !!discLoadedOnce;
          if (late) postMessage({ cmd: 'print', txt: '[players] ⚠ SET AFTER THE DISC LOADED — the controllers were already created; this will NOT take effect until the next load' });
          postMessage({ cmd: 'print', txt: '[players] presenting ' + got + ' controller(s)' + (late ? ' (TOO LATE)' : '') });
          postMessage({ cmd: 'players', ok: !late && got === n, n: got, late });
        } catch (err) {
          postMessage({ cmd: 'players', ok: false, n: 0, late: false, error: String(err) });
        }
        break;
      }
      // THE WITNESS: has the core actually POLLED each port? A plug that did not
      // take is silent — the bytes arrive and nothing reads them — so this is
      // the difference between "delivered" and "read".
      case 'portPolls': {
        const out = [];
        try {
          for (let p = 0; p < 4; p++) out.push(Module._emscripten_get_port_polls(p) >>> 0);
        } catch (err) {
          postMessage({ cmd: 'portPolls', ok: false, polls: [], error: String(err) });
          break;
        }
        postMessage({ cmd: 'portPolls', ok: true, polls: out,
                      players: (typeof Module._emscripten_get_player_ports === 'function')
                               ? (Module._emscripten_get_player_ports() >>> 0) : -1 });
        break;
      }
      case 'mem-init':
        // Already bootstrapped — ignore late re-sends.
        return;

      // Lazy disc. The eager path writes the whole 1.18 GB Track3 into MEMFS
      // (JS heap) after the page has already assembled it — ~1.7 GB resident
      // plus a transient double copy, which no phone can hold, and it makes
      // the user wait for a 1.1 GB download before the first frame. Here the
      // file is a virtual node: reads pull 1 MB chunks over HTTP Range from
      // the split parts and keep a bounded LRU, so footprint is flat and
      // startup fetches only what the game actually touches.
      case 'discLazy': {
        try {
          const FS = Module.FS;
          try { FS.mkdir('/discs'); } catch (_) {}
          const CHUNK = 1 << 20;
          // Budget + readahead come from the page's per-device policy.
          const BUDGET = ((data.cacheMB | 0) || 96) << 20;
          const READAHEAD = data.readahead === undefined ? 4 : (data.readahead | 0);
          const parts = data.parts;         // [{url, size}]  size = size ON THE SERVER
          let total = 0;
          for (const p of parts) { p.start = total; total += p.size; }

          // ── BLOCK-COMPRESSED (.bgz) DISCS ───────────────────────────────────
          // With an index, each p.size above is a part's COMPRESSED size, so the
          // running total is a compressed total and is NOT the disc size. The
          // index carries the real one, and every read goes through BGZ.locate
          // rather than the raw-part arithmetic below.
          //
          // The index arrives in its WIRE form and is prepared here, in this
          // realm, so the worker's block offsets are re-derived from the block
          // lengths instead of being handed the page's already-computed ones.
          // If the two ever disagree, that is exactly the bug worth catching.
          let ix = null;
          if (data.index) {
            if (typeof BGZ === 'undefined') {
              throw new Error('/lib/bgz.js did not load — cannot stream a block-compressed disc');
            }
            ix = BGZ.prepare(data.index, '');
            // The index stores bare filenames; the page preflighted absolute
            // URLs. Use the preflighted ones so the bytes read are the bytes
            // that were verified to answer 206.
            if (ix.parts.length !== parts.length) {
              throw new Error('bgz: index has ' + ix.parts.length + ' parts, the page verified ' + parts.length);
            }
            for (let i = 0; i < ix.parts.length; i++) {
              if (ix.parts[i].csize !== parts[i].size) {
                throw new Error('bgz: part ' + i + ' is ' + parts[i].size +
                                ' B on the server, index says ' + ix.parts[i].csize);
              }
              ix.parts[i].url = parts[i].url;
            }
            total = ix.bytes;
          }

          const chunkCache = new Map();     // chunkIdx -> Uint8Array (insertion order = LRU)
          const blockCache = new Map();     // bgz: BGZ key -> inflated block (insertion order = LRU)
          const wholeParts = new Map();     // partIdx -> Uint8Array (server ignored Range)

          function httpRange(url, from, to) {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, false);    // sync XHR is legal in a worker
            xhr.setRequestHeader('Range', 'bytes=' + from + '-' + to);
            xhr.responseType = 'arraybuffer';
            xhr.send(null);
            if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304))
              throw new Error('disc range fetch failed: ' + url + ' ' + xhr.status);
            return { bytes: new Uint8Array(xhr.response), partial: xhr.status === 206 };
          }

          // Bytes [from,to] within one part, honouring a Range-less server by
          // caching that part whole (python3 -m http.server does this).
          function partBytes(pi, from, to) {
            const whole = wholeParts.get(pi);
            if (whole) return whole.subarray(from, to + 1);
            const r = httpRange(parts[pi].url, from, to);
            if (!r.partial && r.bytes.length === parts[pi].size) {
              wholeParts.set(pi, r.bytes);
              return r.bytes.subarray(from, to + 1);
            }
            return r.bytes;
          }

          function evict() {
            while (chunkCache.size * CHUNK > BUDGET) {
              chunkCache.delete(chunkCache.keys().next().value);
              lazyStats.evicted++;
            }
          }

          // Readahead. Disc reads run forward, so pull the next chunks while
          // the guest chews on this one. ASYNC fetch on purpose: a sync XHR
          // here would stall the emulator thread, which is the opposite of the
          // point. Misses simply fall back to the sync path.
          const inFlight = new Set();
          function readAhead(ci) {
            if (READAHEAD <= 0) return;
            const nChunks = Math.ceil(total / CHUNK);
            for (let k = 1; k <= READAHEAD; k++) {
              const n = ci + k;
              if (n >= nChunks || chunkCache.has(n) || inFlight.has(n)) continue;
              inFlight.add(n);
              const start = n * CHUNK, end = Math.min(total, start + CHUNK) - 1;
              // A chunk can straddle two parts; only prefetch the simple
              // single-part case and let the sync path handle the seam.
              let pi = -1;
              for (let i = 0; i < parts.length; i++) {
                if (start >= parts[i].start && end <= parts[i].start + parts[i].size - 1) { pi = i; break; }
              }
              if (pi < 0) { inFlight.delete(n); continue; }
              const p = parts[pi];
              fetch(p.url, { headers: { Range: 'bytes=' + (start - p.start) + '-' + (end - p.start) } })
                .then((r) => (r.ok ? r.arrayBuffer() : null))
                .then((ab) => {
                  inFlight.delete(n);
                  if (!ab || chunkCache.has(n)) return;
                  chunkCache.set(n, new Uint8Array(ab));
                  lazyStats.ahead++;
                  lazyStats.bytes += ab.byteLength;
                  evict();
                })
                .catch(() => { inFlight.delete(n); });
            }
          }

          function getChunk(ci) {
            const hit = chunkCache.get(ci);
            if (hit) {
              chunkCache.delete(ci); chunkCache.set(ci, hit); lazyStats.hits++;
              readAhead(ci);
              return hit;
            }
            lazyStats.misses++;
            const start = ci * CHUNK;
            const end = Math.min(total, start + CHUNK) - 1;
            const out = new Uint8Array(end - start + 1);
            for (let pi = 0; pi < parts.length; pi++) {
              const p = parts[pi], pStart = p.start, pEnd = p.start + p.size - 1;
              if (end < pStart || start > pEnd) continue;
              const gFrom = Math.max(start, pStart), gTo = Math.min(end, pEnd);
              out.set(partBytes(pi, gFrom - pStart, gTo - pStart), gFrom - start);
            }
            chunkCache.set(ci, out);
            lazyStats.bytes += out.length;
            evict();
            readAhead(ci);
            return out;
          }

          // ── the .bgz equivalents ────────────────────────────────────────────
          // Same shape as above — LRU + forward readahead — but the unit is one
          // gzip member, so a miss costs ONE Range fetch of that member's
          // compressed extent plus one inflate. Measured on this machine: a
          // 256 KiB member inflates in 1.92 ms through the pure-JS path.
          function evictBlocks() {
            while (blockCache.size * ix.block > BUDGET) {
              blockCache.delete(blockCache.keys().next().value);
              lazyStats.evicted++;
            }
          }

          // The compressed bytes of one block, honouring a Range-less server by
          // keeping that part whole — the same concession partBytes() makes.
          function bgzCompressed(loc) {
            const want = loc.cTo - loc.cFrom + 1;
            const whole = wholeParts.get(loc.partIndex);
            if (whole) return whole.subarray(loc.cFrom, loc.cTo + 1);
            const r = httpRange(loc.url, loc.cFrom, loc.cTo);
            if (!r.partial && r.bytes.length === loc.part.csize) {
              wholeParts.set(loc.partIndex, r.bytes);
              return r.bytes.subarray(loc.cFrom, loc.cTo + 1);
            }
            // A short 206 would otherwise reach the inflater as a truncated
            // member and surface as a confusing CRC error. Name it here.
            if (r.bytes.length !== want) {
              throw new Error('bgz: ' + loc.url + ' returned ' + r.bytes.length +
                              ' B for a ' + want + ' B block request');
            }
            return r.bytes;
          }

          function bgzReadAhead(loc) {
            if (READAHEAD <= 0) return;
            let n = loc;
            for (let k = 0; k < READAHEAD; k++) {
              n = BGZ.next(ix, n);
              if (!n) return;
              const L = n, key = L.key;
              if (blockCache.has(key) || inFlight.has(key)) continue;
              inFlight.add(key);
              // ASYNC on purpose, and inflated with the NATIVE decompressor:
              // a sync XHR plus a JS inflate here would stall the emulator
              // thread, which is the opposite of the point.
              fetch(L.url, { headers: { Range: 'bytes=' + L.cFrom + '-' + L.cTo } })
                .then((r) => (r.ok ? r.arrayBuffer() : null))
                .then((ab) => (ab && !blockCache.has(key)) ? BGZ.inflateMemberAsync(new Uint8Array(ab)) : null)
                .then((u8) => {
                  inFlight.delete(key);
                  if (!u8 || blockCache.has(key) || u8.length !== L.uLen) return;
                  blockCache.set(key, u8);
                  lazyStats.ahead++;
                  lazyStats.bytes += u8.length;
                  evictBlocks();
                })
                .catch(() => { inFlight.delete(key); });
            }
          }

          function getBlock(loc) {
            const hit = blockCache.get(loc.key);
            if (hit) {
              blockCache.delete(loc.key); blockCache.set(loc.key, hit); lazyStats.hits++;
              bgzReadAhead(loc);
              return hit;
            }
            lazyStats.misses++;
            const out = BGZ.inflateMemberSync(bgzCompressed(loc));
            // The index says how long this block must be. A disagreement means
            // the parts and the index came from different data — refuse rather
            // than hand the SH4 a plausible-looking wrong disc.
            if (out.length !== loc.uLen) {
              throw new Error('bgz: block inflated to ' + out.length + ' B, index says ' + loc.uLen);
            }
            blockCache.set(loc.key, out);
            lazyStats.bytes += out.length;
            evictBlocks();
            bgzReadAhead(loc);
            return out;
          }

          const node = FS.createFile('/discs', data.name, {}, true, false);
          Object.defineProperty(node, 'usedBytes', { get: () => total, configurable: true });
          node.contents = null;
          const ops = Object.assign({}, node.stream_ops);
          ops.read = (stream, buffer, offset, length, position) => {
            if (position >= total) return 0;
            const size = Math.min(total - position, length);
            let done = 0;
            while (done < size) {
              const pos = position + done;
              // One region — a 1 MiB chunk of a raw part, or one gzip member of
              // a .bgz part. Both are "the bytes around pos, and where they
              // start", so the copy below is shared.
              let region, base;
              if (ix) {
                const loc = BGZ.locate(ix, pos);
                if (!loc) break;
                region = getBlock(loc); base = loc.uOff;
              } else {
                const ci = (pos / CHUNK) | 0;
                region = getChunk(ci); base = ci * CHUNK;
              }
              const inR = pos - base;
              const n = Math.min(region.length - inR, size - done);
              if (n <= 0) break;                 // never spin on a short region
              buffer.set(region.subarray(inR, inR + n), offset + done);
              done += n;
            }
            // `done`, not `size`: a short read must be reported short rather
            // than claiming bytes that were never written into the buffer.
            return done;
          };
          ops.write = () => { throw new FS.ErrnoError(1); };   // read-only medium
          node.stream_ops = ops;

          postMessage({ cmd: 'print', txt: '[flycast-shim] lazy disc /discs/' + data.name +
                        ' (' + total + ' B over ' + parts.length + ' parts, ' +
                        (BUDGET >> 20) + 'MB cache, readahead ' + READAHEAD + ')' });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[flycast-shim] lazy disc failed: ' + (err && err.message ? err.message : String(err)) });
        }
        break;
      }

      case 'discChunk': {
        // Stream the disc into MEMFS at /discs/<name>. .cue references its
        // .bin tracks by relative filename, so we mkdir /discs once and
        // keep all of cue + bin in the same directory.
        try { Module.FS.mkdir('/discs'); } catch (_) {}
        const u8 = new Uint8Array(data.bytes);
        const path = '/discs/' + data.name;
        Module.FS.writeFile(path, u8);
        // MEM DIAG (mobile-footprint campaign): MEMFS keeps contents in the JS
        // heap, so track both sides — wasm linear memory and the worker heap.
        let mem = '';
        try {
          const wasmMB = (Module.HEAPU8.length / 1048576) | 0;
          mem = ' wasm=' + wasmMB + 'MB';
          if (typeof performance !== 'undefined' && performance.memory)
            mem += ' jsheap=' + ((performance.memory.usedJSHeapSize / 1048576) | 0) + 'MB';
        } catch (_) {}
        postMessage({ cmd: 'print', txt: '[flycast-shim] wrote ' + path + ' (' + u8.byteLength + ' B)' + mem });
        break;
      }

      case 'discReady': {
        // ── PER-GAME CUSTOM-TEXTURE DIRECTORY ────────────────────────────────
        // flycast stats /bios/dc/textures/<PRODUCT-ID>/ while loading a disc and
        // THROWS if it is absent, which surfaces as the disc being rejected:
        //   load_disc: std::exception during retro_load_game:
        //     Cannot stat /bios/dc/textures/T1215N/
        // PSO never hit this because flycast_worker_link.sh:386 embeds a
        // placeholder for exactly ONE id — MK-51193, which IS PSO Ver.2 — so the
        // hole only opened when a second game was added. EmscriptenWorker.cpp:1180
        // already forces CustomTextures off; that suppresses the PRELOADER, not
        // this stat.
        // Rather than embed a directory per game (a relink, and a new way to
        // forget one), read the product id out of the disc: every Dreamcast image
        // carries an IP.BIN whose header is 'SEGA SEGAKATANA' with the product
        // number at +0x40. Verified against both discs present when this was
        // written — pso2 -> 'MK-51193' (matching the embedded placeholder) and
        // cannonspike -> 'T1215N' (matching the thrown path).
        // Only the first 64 KB of each file is read: a full FS.readFile of a
        // 1.19 GB track would be a catastrophic copy.
        try {
          // FAST PATH: the page passes the product id from the catalog when it
          // knows it. Needed for .cdi, where IP.BIN is NOT near the start — in
          // Marvel vs Capcom 2's image the 'SEGA SEGAKATANA' header sits at
          // 0x4b85988 (~79 MB in), so the 64 KB scan below cannot reach it and
          // would leave the directory uncreated. Scanning that far in the worker
          // is a lot of reading to rediscover a constant the catalog can just
          // state. The scan remains as the fallback for a disc added without one.
          if (data.productId) {
            let made = '';
            for (const seg of ['/bios', '/bios/dc', '/bios/dc/textures', '/bios/dc/textures/' + data.productId]) {
              try { Module.FS.mkdir(seg); made = seg; } catch (_) {}
            }
            postMessage({ cmd: 'print', txt: '[flycast-shim] disc product id ' + data.productId +
                          ' (from catalog) — texture dir ready' + (made ? (' (created ' + made + ')') : '') });
            throw { __done: true };
          }
          const dir = '/discs';
          for (const nm of Module.FS.readdir(dir)) {
            if (nm === '.' || nm === '..') continue;
            let st = null;
            try {
              st = Module.FS.open(dir + '/' + nm, 'r');
              const buf = new Uint8Array(65536);
              const n = Module.FS.read(st, buf, 0, buf.length, 0);
              let sig = -1;
              const NEEDLE = 'SEGA SEGAKATANA';
              for (let i = 0; i + NEEDLE.length < n; i++) {
                let ok = true;
                for (let k = 0; k < NEEDLE.length; k++) { if (buf[i + k] !== NEEDLE.charCodeAt(k)) { ok = false; break; } }
                if (ok) { sig = i; break; }
              }
              if (sig < 0) continue;
              let id = '';
              for (let k = 0; k < 10; k++) id += String.fromCharCode(buf[sig + 0x40 + k]);
              id = id.replace(/\0/g, '').trim();
              if (!id) continue;
              let made = '';
              for (const seg of ['/bios', '/bios/dc', '/bios/dc/textures', '/bios/dc/textures/' + id]) {
                try { Module.FS.mkdir(seg); made = seg; } catch (_) { /* already there */ }
              }
              postMessage({ cmd: 'print', txt: '[flycast-shim] disc product id ' + id +
                            ' — texture dir ready' + (made ? (' (created ' + made + ')') : ' (already present)') });
              break;
            } catch (_) { /* unreadable entry: try the next */ }
            finally { if (st) { try { Module.FS.close(st); } catch (_) {} } }
          }
        } catch (err) {
          // Never fatal: if this fails the core simply behaves as it did before.
          if (!(err && err.__done))
            postMessage({ cmd: 'print', txt: '[flycast-shim] texture-dir prep skipped: ' + (err && err.message ? err.message : String(err)) });
        }
        try {
          const ret = Module.ccall('emscripten_load_disc', 'number', ['string'], [data.cuePath]);
          discLoadedOnce = true;   // any later 'players' is too late to take effect
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
          postMessage({ cmd: 'print', txt: '[flycast-shim] run_iter threw: ' +
            describeThrow(Module, err) + pcTxt + sh4StateLine(Module) + stk });
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
          if (ok && !freerun) { freerun = true; pumpKick(0); }
          // A lockstep session restarts its frame numbering at the state it was
          // handed; anything still queued belongs to the machine we just threw
          // away. `frame` is optional so single-player Load State is unchanged.
          if (lockstep) {
            lsQueue.clear(); lsPendingHash = -1; lsStallSince = 0;
            lsFrame = data.frame | 0;
          }
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
            if (freerun) pumpKick(0);
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

      // VMU seed + persistence. The wasm VMU is in-memory only, so the page
      // owns the card: it writes one in before the guest reads it (seed) and
      // saves snapshots back. Watching stays OFF until the page has decided
      // what to seed, so a blank power-on card can never overwrite a good
      // stored one.
      case 'vmuLoad': {
        // data.port selects the seat (0 == Player 1). An absent port means 0,
        // which is what the single-card contract used to mean.
        const port = (data.port | 0) >= 0 && (data.port | 0) < VMU_PORTS_MAX ? (data.port | 0) : 0;
        // Deferred to an exact frame — see vmuAtFrame above. Anything already
        // at or past that frame is applied immediately rather than dropped,
        // because a card that silently never lands is the bug being fixed.
        if (data.atFrame != null && (data.atFrame | 0) > lsFrame) {
          vmuAtFrame.push({ port: port, data: data.data, atFrame: data.atFrame | 0 });
          postMessage({ cmd: 'print', txt: '[vmu] port ' + port + ': queued for frame ' + (data.atFrame | 0) +
                        ' (now at ' + lsFrame + ') — every console writes it on the same frame or the room forks' });
          break;
        }
        try {
          const M = self.Module;
          const ptr = M._flycast_vmu_ptr(port) >>> 0, size = M._flycast_vmu_size(port) >>> 0;
          const src = new Uint8Array(data.data);
          if (!ptr || !size) {
            postMessage({ cmd: 'print', txt: '[vmu] port ' + port + ': no card attached — seed skipped' });
            postMessage({ cmd: 'vmuSeeded', port: port, ok: false, why: 'no card on that port' });
            break;
          }
          if (src.length !== size) {
            postMessage({ cmd: 'print', txt: '[vmu] port ' + port + ': seed is ' + src.length + ' B, card is ' + size + ' B — seed skipped' });
            postMessage({ cmd: 'vmuSeeded', port: port, ok: false, why: 'size mismatch' });
            break;
          }
          M.HEAPU8.set(src, ptr);
          // don't echo our own write back out as a change
          vmuGenSeen[port] = M._flycast_vmu_gen(port) >>> 0;
          postMessage({ cmd: 'print', txt: '[vmu] port ' + port + ': seeded ' + size + ' B into the card' });
          postMessage({ cmd: 'vmuSeeded', port: port, ok: true });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[vmu] port ' + port + ': seed threw: ' + (err && err.message ? err.message : String(err)) });
          postMessage({ cmd: 'vmuSeeded', port: port, ok: false, why: 'threw' });
        }
        break;
      }
      case 'vmuWatch': {
        try {
          const M = self.Module;
          vmuPortCount = vmuPortsFromCore();
          // Bank every port's CURRENT generation so arming the watch does not
          // immediately re-emit cards nobody touched.
          for (let p = 0; p < VMU_PORTS_MAX; p++)
            vmuGenSeen[p] = (M && M._flycast_vmu_gen) ? (M._flycast_vmu_gen(p) >>> 0) : 0;
          vmuWatch = !!data.on;
          postMessage({ cmd: 'print', txt: '[vmu] watch=' + (vmuWatch ? 1 : 0) + ' ports=' + vmuPortCount });
        } catch (_) {}
        break;
      }
      // Read one card's LIVE bytes straight out of the core. Read-only, and the
      // only way to prove from outside that two seats hold two DIFFERENT
      // buffers — which is exactly what the single-pointer contract could not
      // express and what the two-player card test asserts.
      case 'vmuDump': {
        const port = (data.port | 0) >= 0 && (data.port | 0) < VMU_PORTS_MAX ? (data.port | 0) : 0;
        try {
          const M = self.Module;
          const ptr = M._flycast_vmu_ptr(port) >>> 0, size = M._flycast_vmu_size(port) >>> 0;
          if (!ptr || !size) { postMessage({ cmd: 'vmuDump', port: port, data: null, ptr: 0, size: 0 }); break; }
          const copy = new Uint8Array(M.HEAPU8.subarray(ptr, ptr + size));
          postMessage({ cmd: 'vmuDump', port: port, data: copy, ptr: ptr, size: size,
                        gen: M._flycast_vmu_gen(port) >>> 0 }, [copy.buffer]);
        } catch (err) {
          postMessage({ cmd: 'vmuDump', port: port, data: null, ptr: 0, size: 0,
                        error: String(err && err.message || err) });
        }
        break;
      }
      // Card inventory, so the page can seed only the slots that exist and can
      // report honestly when a seat has no card rather than inventing one.
      case 'vmuInfo': {
        try {
          const M = self.Module;
          vmuPortCount = vmuPortsFromCore();
          const slots = [];
          for (let p = 0; p < (vmuPortCount || 0); p++) {
            slots.push({
              port: p,
              size: (M && M._flycast_vmu_size) ? (M._flycast_vmu_size(p) >>> 0) : 0,
              gen:  (M && M._flycast_vmu_gen)  ? (M._flycast_vmu_gen(p)  >>> 0) : 0,
              present: !!((M && M._flycast_vmu_ptr) ? (M._flycast_vmu_ptr(p) >>> 0) : 0),
            });
          }
          postMessage({ cmd: 'vmuInfo', ports: vmuPortCount, slots: slots });
          postMessage({ cmd: 'print', txt: '[vmu] slots: ' +
            (slots.length ? slots.map((x) => 'p' + x.port + (x.present ? '=' + x.size + 'B' : '=none')).join(' ')
                          : 'none — this binary has no per-port VMU accessors') });
        } catch (err) {
          postMessage({ cmd: 'vmuInfo', ports: 0, slots: [], error: String(err && err.message || err) });
        }
        break;
      }

      case 'setidleskip': {
        try {
          if (Module._flycast_set_idleskip) Module._flycast_set_idleskip((data.on | 0));
          postMessage({ cmd: 'print', txt: '[setidleskip] g_idleskip=' + (data.on | 0) });
        } catch (err) {
          postMessage({ cmd: 'print', txt: '[setidleskip] threw: ' + (err && err.message ? err.message : String(err)) });
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
            //
            // [2026-08-29] The four writer counters DO NOT ACCOUNT FOR icgen on
            // their own -- a 75 s campaign read smcS=smcB=smcR=smcT=0 while
            // icgen still advanced 2 -> 5, so "no SMC occurred" was NOT provable
            // from them. The ledger is now closed (rec_wasm.cpp, see the
            // g_smc_mark_counts note): smcI/smcC/smcX/smcP are the four
            // administrative paths (savestate invalidate / jit_clear / bm reset
            // / periodic flush) and smcE is the DERIVED count of generation
            // units contributed by the emitted in-wasm store mark, which is
            // branchless on the hot store path and cannot be counted inline.
            // IDENTITY, and the thing to check: over any window,
            //     d(icgen) == d(smcS+smcB+smcR+smcT+smcI+smcC+smcX+smcP+smcE)
            // exactly, by construction. "No SMC occurred" == d(icgen) is 0.
            ' icgen=' + (f(74)>>>0) + ' smcS=' + (f(75)>>>0) + ' smcB=' + (f(76)>>>0) + ' smcR=' + (f(77)>>>0) + ' cpg=' + (f(78)>>>0) + ' smcT=' + (f(79)>>>0) +
            ' smcI=' + (f(103)>>>0) + ' smcC=' + (f(104)>>>0) + ' smcX=' + (f(105)>>>0) + ' smcP=' + (f(106)>>>0) + ' smcAcc=' + (f(107)>>>0) + ' smcE=' + (f(108)>>>0) +
            ' smcA=0x' + h(f(80)) + ' syncsr=' + (f(81)>>>0) + ' shms=' + (f(82)>>>0) + ' rrms=' + (f(83)>>>0) + ' ftrv=' + (f(84)>>>0) + ' fipr=' + (f(85)>>>0) + ' fsca=' + (f(86)>>>0) + ' ifbo=' + (f(87)>>>0) + ' icn=' + (f(88)>>>0) + ' syncfp=' + (f(89)>>>0) + ' isk=' + (f(90)>>>0) });
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
