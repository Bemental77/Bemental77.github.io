// jit_compile_worker.js — the N64 JIT's emitter, off the core's thread.
//
// The core's thread (the core worker, or the page in ?worker=0) offers each
// span to mips_emit.js; with OFF-THREAD EMISSION on (see mips_emit.js) it
// posts the span's inputs here instead of building the module itself. This
// worker runs THE SAME mips_emit.js (bementalMips.emitBatch: compileSpan on a
// copy of each offer's inputs, stopped after emission, all of a message's offers
// assembled into one module), compiles the bytes and posts the WebAssembly.Module back. It touches no guest state: what comes back is
// installed by the core's thread at a field end, and only if every input is
// still what it was (mips_emit.js asyncStillHolds).
//
// Loaded as  new Worker('/n64/bementalJIT/jit_compile_worker.js?v=<same v as mips_emit.js>')
self.window = self;
(function () {
  var v = '';
  try { v = new URL(self.location.href).searchParams.get('v') || ''; } catch (e) {}
  importScripts('/n64/bementalJIT/mips_emit.js?v=' + encodeURIComponent(v));
})();
var moduleCloneOk = true;
// one job, or a batch of them (mips_emit.js asyncFlush); the answers go back as one batch
function one(job) {
  var r = self.bementalMips.emitJob(job);
  if (!r.ok) return r;
  var mod = null;
  try { mod = new WebAssembly.Module(r.bytes); } catch (er) { return { id: r.id, ok: false, err: 'compile: ' + ((er && er.message) || er) }; }
  return { id: r.id, ok: true, labels: r.labels, labelOps: r.labelOps, maxW: r.maxW, maxO: r.maxO, mod: mod, bytes: r.bytes };
}
function send(out) {
  if (!out.length) return;
  if (moduleCloneOk) {
    var withMods = out.map(function (o) { return o.ok ? { id: o.id, ok: true, labels: o.labels, labelOps: o.labelOps, maxW: o.maxW, maxO: o.maxO, mod: o.mod } : o; });
    try { self.postMessage(withMods); return; } catch (er) { moduleCloneOk = false; }   // a browser that cannot clone a Module
  }
  var tr = [];
  out.forEach(function (o) { if (o.ok) { o.mod = null; tr.push(o.bytes.buffer); } });
  self.postMessage(out, tr);
}
// BATCHED MODULES (mips_emit.js): every message's offers become ONE module — a dispatch into a
// span of a module the core has already entered costs a fraction of one into a new module
// EAGER COMPILE (2026-10-03). V8 compiles a wasm function LAZILY, on its first call — so a
// module built here was only validated here, and each span's Liftoff compile (3.1 ms for a
// 292-instruction MK64 span on this box, node 22) ran on the CORE's thread, inside the first field
// that entered it. Calling every function of the module once here, with the delay-slot flag set
// in a scratch memory, compiles it in this thread instead: each function's first instruction is
// that flag's test (the DELAY-SLOT ENTRY GUARD), which then calls a scratch no-op and returns —
// nothing else runs, nothing of the guest is touched. A module posted to the core shares its
// compiled code (one process, one NativeModule), so the core's first call finds it compiled.
var warm = { mem: null, table: null, ds: 0, n: 0 };
function prewarm(mod, jobs) {
  var p = null;
  for (var i = 0; i < jobs.length; i++) if (jobs[i] && jobs[i].p && jobs[i].p.delaySlot) { p = jobs[i].p; break; }
  if (!p) return;
  var tb = jobs[0].tableBase | 0;
  try {
    if (!warm.mem || warm.ds !== p.delaySlot) {
      // the entry guard reads skip_jump as well as delay_slot (mips_emit.js SKIP_JUMP AT ENTRY):
      // both must be inside the scratch memory
      warm.mem = new WebAssembly.Memory({ initial: ((Math.max(p.delaySlot, p.skipJump >>> 0) + 8) >>> 16) + 1 });
      new Uint32Array(warm.mem.buffer)[p.delaySlot >> 2] = 1;
      warm.ds = p.delaySlot;
    }
    if (!warm.table || warm.n < tb) {
      var noop = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0, 10, 4, 1, 2, 0, 0x0b])), {}).exports.f;
      warm.table = new WebAssembly.Table({ initial: tb + 1, element: 'anyfunc' });
      for (var k = 1; k <= tb; k++) warm.table.set(k, noop);
      warm.n = tb;
    }
    var inst = new WebAssembly.Instance(mod, { e: { t: warm.table, m: warm.mem } });
    var ex = inst.exports;
    for (var name in ex) if (name.charAt(0) === 's' && typeof ex[name] === 'function') ex[name]();
  } catch (e) { warm.err = String((e && e.message) || e).slice(0, 120); }
}
function batch(jobs) {
  var r = self.bementalMips.emitBatch(jobs);
  if (!r.bytes) return r;
  try { r.mod = new WebAssembly.Module(r.bytes); prewarm(r.mod, jobs); }
  catch (er) {
    var msg = 'compile: ' + ((er && er.message) || er);
    return { batch: true, items: r.items.map(function (it) { return it.ok ? { id: it.id, ok: false, err: msg } : it; }), bytes: null };
  }
  return r;
}
function sendBatch(r) {
  if (moduleCloneOk && r.mod) {
    try { self.postMessage([{ batch: true, items: r.items, mod: r.mod, spans: r.spans, ms: r.ms }]); return; } catch (er) { moduleCloneOk = false; }
  }
  var tr = r.bytes ? [r.bytes.buffer] : [];
  self.postMessage([{ batch: true, items: r.items, bytes: r.bytes, spans: r.spans, ms: r.ms }], tr);
}
self.onmessage = function (e) {
  var jobs = Array.isArray(e.data) ? e.data : [e.data];
  if (self.bementalMips.emitBatch) { sendBatch(batch(jobs)); return; }
  // answers go back every ~8 ms of work, so a big batch does not hold the first ones
  var out = [], t = performance.now();
  for (var i = 0; i < jobs.length; i++) {
    out.push(one(jobs[i]));
    if (performance.now() - t > 8) { send(out); out = []; t = performance.now(); }
  }
  send(out);
};
