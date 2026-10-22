// gamecube/native/src/rollback_lib.js (--js-library): stand-ins for the write barrier's entry points.
// wb/instrument.sh merges wb/barrier.wat into the wasm, which resolves these imports inside the
// module; a wasm built without it gets these, and rollback refuses to enable (present() == 0).
addToLibrary({
  mp4web_barrier_init: function (base, pages, table) {},
  mp4web_barrier_present: function () { return 0; },
});

// A ZERO-DELAY YIELD WITHOUT THE 4 ms CLAMP. emscripten_sleep(ms) is setTimeout(ms) underneath, and every frame
// runs inside the previous sleep's timer callback, so the timers nest without end: the HTML timer rule clamps
// a nested setTimeout (level > 5) to >= 4 ms. Measured on the toaster rig (rb build, solo board): every one of
// 2,081 sleep(0)s in a 20 s window was nested deeper than 5 and took 4-6+ ms (mean 6.35 ms, none under 4) —
// a frame that was already late waited 4+ ms more before it could start, which is what a console repaying debt
// (a room's catch-up frames) can least afford. A sleep of 0 now yields through a MessageChannel message (a
// task, so rendering and input still run between frames; no clamp, no spinning). A positive sleep is a real
// deadline and stays a timer.
addToLibrary({
  $mp4ZeroYield__deps: ['$callUserCallback'],
  $mp4ZeroYield: (fn) => {
    const z = mp4ZeroYield;
    if (!z.ch) { z.q = []; z.ch = new MessageChannel(); z.ch.port1.onmessage = () => { const f = z.q.shift(); if (f) callUserCallback(f); }; }
    z.q.push(fn); z.ch.port2.postMessage(0);
  },
  emscripten_sleep__deps: ['$safeSetTimeout', '$mp4ZeroYield'],
  emscripten_sleep__async: true,
  emscripten_sleep: (ms) => Asyncify.handleSleep((wakeUp) => (ms > 0 ? safeSetTimeout(wakeUp, ms) : mp4ZeroYield(wakeUp))),
});
