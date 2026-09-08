// dreamcast/tools/pump_fixture/stub_core.js — a fake flycast core, for testing
// the PUMP and nothing else.
//
// WHY A STUB AND NOT THE REAL CORE. The question this fixture answers is "does
// the pump advance exactly one emulated frame per delivered input pair, and
// does it refuse to advance without one" — which is a property of
// flycast_worker.js, not of flycast. Booting the real core needs a 1.18 GB disc
// and ~20 s, and its frame timing is variable, so a stall of 40 ms and a slow
// frame of 40 ms would be indistinguishable. Here a frame is exact and free, so
// the gate is measured directly.
//
// ⚠ THE SHIM UNDER TEST IS THE REAL FILE. The runner COPIES
// dreamcast/flycast_libretro/flycast_worker.js into this directory and deletes
// it afterwards — there is deliberately no second copy of the pump to drift.
//
// It presents itself exactly as the emcc output does: a global factory named
// flycastWorkerModule (MODULARIZE=1 EXPORT_NAME=flycastWorkerModule) resolving
// to the Module object, with the handful of exports the shim actually calls.
(function () {
  const SH4_HZ = 200000000;
  const CYCLES_PER_FRAME = SH4_HZ / 60;          // one iter == one 60 Hz frame
  const HEAP_BYTES = 4 << 20;
  const MAPLE_OFF = 1 << 20;                     // 256 B of pad image
  const SUSPEND_OFF = MAPLE_OFF + 256;           // the asyncify "in flight" byte
  const MARK_SUSPEND = 0xab;                     // pad byte 63 that arms it

  self.flycastWorkerModule = function (moduleArg) {
    const M = moduleArg || {};
    const heap = new Uint8Array(HEAP_BYTES);
    M.HEAPU8 = heap;
    M.HEAPU32 = new Uint32Array(heap.buffer);
    let brk = 2 << 20;
    let frames = 0;
    let cycles = 0;
    // A one-word digest of every pad image this core has ever been handed, in
    // order. Two cores fed the same inputs in the same order agree; a dropped,
    // duplicated or reordered frame does not. It is what makes this stub a
    // DETERMINISTIC core rather than a counter.
    let padDigest = 0x811c9dc5 >>> 0;

    M._malloc = function (n) { const p = brk; brk += (n + 15) & ~15; return p; };
    M._free = function () {};
    M._emscripten_set_video_target = function () {};
    M._emscripten_set_audio_ring = function () {};
    M._emscripten_create_gl_context = function () { return 1; };
    M._emscripten_worker_init = function () {};
    M._emscripten_get_maple_ptr = function () { return MAPLE_OFF; };
    M._flycast_run_iter_flag_ptr = function () { return SUSPEND_OFF; };
    M._flycast_guest_cycles = function () { return cycles; };

    M._emscripten_run_iter = function () {
      for (let i = 0; i < 256; i++) {
        padDigest = (padDigest ^ heap[MAPLE_OFF + i]) >>> 0;
        padDigest = Math.imul(padDigest, 0x01000193) >>> 0;
      }
      frames++;
      cycles += CYCLES_PER_FRAME;
      // Arm the asyncify-suspended flag on request, so the fixture can prove
      // the shim refuses to fingerprint a mid-suspend core.
      // A real asyncify suspension is TRANSIENT — the frame unwinds, its timer
      // rewinds, and it finishes. Model that: arm the flag on the marker and
      // let it decay, so the pump un-parks on its own exactly as it would with
      // the real core. (Without the decay the fixture wedges: once parked no
      // further frame runs, and only run_iter clears the flag.)
      if (heap[MAPLE_OFF + 63] === MARK_SUSPEND && !heap[SUSPEND_OFF]) {
        heap[SUSPEND_OFF] = 1;
        setTimeout(function () { heap[SUSPEND_OFF] = 0; }, 1500);
      } else if (heap[MAPLE_OFF + 63] !== MARK_SUSPEND) {
        heap[SUSPEND_OFF] = 0;
      }
    };
    M._flycast_ctx_snapshot = function (which) {
      switch (which) {
        case 0: return padDigest >>> 0;                 // stands in for pc
        case 3: return (cycles >>> 0);
        case 5: return 1;
        default: return (Math.imul(frames + 1, (which + 1) * 2654435761) >>> 0);
      }
    };
    M._emscripten_save_state = function () { return 0; };
    M._emscripten_load_state = function () { return 1; };
    // The shim reads Module.GL/canvas defensively; leaving them undefined is a
    // path it already handles and prints about.
    return Promise.resolve(M);
  };
})();
