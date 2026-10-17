// src/libco_jspi.js — libco's fiber switch on JSPI (see src/libco_fiber.c, MP4_JSPI).
// mp4web_co_swap(from, to, top, limit): park `from` on a promise and run `to`.
//   first entry (top != 0): point the shadow stack at the new fiber's stack and call the promising
//     export mp4web_co_entry(to) — it runs until its own first switch; the shadow-stack pointer is
//     then whatever that switch set, so nothing here touches it afterwards.
//   resume: put back the target's shadow-stack pointer and limits, resolve its promise; it continues
//     as soon as `from` has suspended (nothing else runs wasm in between).
addToLibrary({
  mp4web_co_swap__async: true,
  mp4web_co_swap__deps: ['$stackSave', '$stackRestore', 'emscripten_stack_set_limits', 'emscripten_stack_get_base', 'emscripten_stack_get_end'],
  mp4web_co_swap: (from, to, top, limit) => {
    var F = Module.mp4Co || (Module.mp4Co = new Map());
    var f = F.get(from); if (!f) { f = {}; F.set(from, f); }
    f.sp = stackSave(); f.base = _emscripten_stack_get_base(); f.end = _emscripten_stack_get_end();
    var p = new Promise((r, j) => { f.resume = r; f.kill = j; });
    if (top) {
      F.set(to, {});
      _emscripten_stack_set_limits(top, limit);
      stackRestore(top);
      Module['_mp4web_co_entry'](to).catch((e) => { if (e !== Module.mp4CoKilled) throw e; });   // settles only when the fiber is killed
    } else {
      var t = F.get(to);
      _emscripten_stack_set_limits(t.base, t.end);
      stackRestore(t.sp);
      var r = t.resume; t.resume = null; t.kill = null; r();
    }
    return p;
  },
  // co_delete of a fiber that is parked in mp4web_co_swap: reject its promise, so its JSPI stack
  // unwinds (a JS exception through C frames — no destructors run, the shadow stack is not touched)
  // and the engine can free it. Without this every finished game process leaked its stack.
  mp4web_co_kill: (c) => {
    var F = Module.mp4Co; if (!F) return;
    var t = F.get(c); F.delete(c);
    if (!Module.mp4CoKilled) Module.mp4CoKilled = new Error('mp4 fiber deleted');
    if (t && t.kill) { var k = t.kill; t.kill = t.resume = null; k(Module.mp4CoKilled); }
  },
});
