// jit_compile_worker.js — the N64 JIT's emitter, off the core's thread.
//
// The core's thread (the core worker, or the page in ?worker=0) offers each
// span to mips_emit.js; with OFF-THREAD EMISSION on (see mips_emit.js) it
// posts the span's inputs here instead of building the module itself. This
// worker runs THE SAME mips_emit.js (bementalMips.emitJob: compileSpan on a
// copy of the inputs, stopped after emission), compiles the bytes and posts the
// WebAssembly.Module back. It touches no guest state: what comes back is
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
  return { id: r.id, ok: true, labels: r.labels, labelOps: r.labelOps, mod: mod, bytes: r.bytes };
}
function send(out) {
  if (!out.length) return;
  if (moduleCloneOk) {
    var withMods = out.map(function (o) { return o.ok ? { id: o.id, ok: true, labels: o.labels, labelOps: o.labelOps, mod: o.mod } : o; });
    try { self.postMessage(withMods); return; } catch (er) { moduleCloneOk = false; }   // a browser that cannot clone a Module
  }
  var tr = [];
  out.forEach(function (o) { if (o.ok) { o.mod = null; tr.push(o.bytes.buffer); } });
  self.postMessage(out, tr);
}
self.onmessage = function (e) {
  // answers go back every ~8 ms of work, so a big batch does not hold the first ones
  var jobs = Array.isArray(e.data) ? e.data : [e.data], out = [], t = performance.now();
  for (var i = 0; i < jobs.length; i++) {
    out.push(one(jobs[i]));
    if (performance.now() - t > 8) { send(out); out = []; t = performance.now(); }
  }
  send(out);
};
