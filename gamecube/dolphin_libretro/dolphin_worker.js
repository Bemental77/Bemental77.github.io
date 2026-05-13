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
    importScripts('dolphin_worker_emcc.js');
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
        // Default locateFile so dolphin_worker_emcc.wasm resolves.
        if (!self.Module.locateFile) {
          self.Module.locateFile = function (f) {
            return new URL(f, self.location.href).href;
          };
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
