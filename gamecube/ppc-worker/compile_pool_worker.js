// gamecube/ppc-worker/compile_pool_worker.js — Phase B3 skeleton.
//
// Dedicated Web Worker for WebAssembly compilation. Receives byte
// buffers via postMessage, calls WebAssembly.compile (async, V8 uses
// its own compile thread), posts the resulting WebAssembly.Module
// back. WebAssembly.Module is structured-cloneable since Chrome 89 /
// Firefox 124, so postMessage transfers it natively.
//
// Status: scaffold. The dispatch loop in ppc_worker.js does not yet
// route compiles through here — it still calls
// `_ppc_worker_compile_block` synchronously and instantiates inline
// (per the 2g self-compile architecture). At our current bottleneck
// (OS scheduler idle loop, iter=23M ceiling under any V8 mode), moving
// compile off the dispatch worker buys ≤1.4% (compile=340 / disp=10000
// per perf snapshot). The infrastructure is here to support the bigger
// wins:
//
// - Phase F1 (ipl-loader AOT precompile): on retro_load_game, parse
//   DOL section ranges, hand them to this pool, fill the cache before
//   dispatch ever sees a miss. Cold-start latency win.
// - Async-dispatch overhaul: dispatch worker on miss enqueues + yields
//   the slice; pool returns Module asynchronously; next slice picks
//   up the cached module. Steady-state win bounded by miss frequency.
//
// Both deferred until measurement (Phase C) tells us which actually
// moves the native-speed needle.
//
// Protocol:
//   page → pool: { cmd: 'compile', tag: <opaque>, bytes: Uint8Array }
//   pool → page: { cmd: 'compile-ack', tag, module }              (success)
//                { cmd: 'compile-nack', tag, error: <string> }    (failure)

self.addEventListener('message', async (e) => {
  const data = e.data || {};
  if (data.cmd !== 'compile') return;
  const tag = data.tag;
  const bytes = data.bytes;
  if (!(bytes instanceof Uint8Array)) {
    self.postMessage({ cmd: 'compile-nack', tag, error: 'bytes not Uint8Array' });
    return;
  }
  try {
    const mod = await WebAssembly.compile(bytes);
    // Module is structured-cloneable; transferable Worker → page.
    self.postMessage({ cmd: 'compile-ack', tag, module: mod });
  } catch (err) {
    self.postMessage({
      cmd: 'compile-nack', tag,
      error: (err && err.message) ? err.message : String(err),
    });
  }
});

self.postMessage({ cmd: 'pool-ready' });
