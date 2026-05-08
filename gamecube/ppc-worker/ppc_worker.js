// gamecube/ppc-worker/ppc_worker.js
// JS-side dedicated PowerPC JIT worker. Loads ppc_worker_emcc.js and
// instantiates it with a SHARED WebAssembly.Memory provided by the page.
// Phase 2c lays the foundation for the dolphin_worker ↔ ppc-worker
// memory sharing — once dolphin_worker is rebuilt with
// `-sIMPORTED_MEMORY=1`, the page allocates ONE memory and gives it to
// both workers.
//
// Protocol (control plane):
//   page → worker  postMessage('mem-init', { memory })
//   worker         instantiates the wasm with that memory
//   worker → page  postMessage('ready', { version })
//   page → worker  postMessage('init', { ppcStateAddr, mem1Addr, ...})
//   worker → page  postMessage('init-ack')
//   page → worker  postMessage('dispatch', { pc })
//   worker → page  postMessage('dispatch-ack', { next })
//   page → worker  postMessage('shutdown')

(function () {
  let mod = null;
  let inited = false;
  let pendingDispatch = null;  // queued if 'dispatch' arrives before 'ready'

  importScripts('./ppc_worker_emcc.js?v=' + Date.now());

  if (typeof ppcWorkerModule !== 'function') {
    postMessage({ cmd: 'error', error: 'ppcWorkerModule factory not found after importScripts' });
    return;
  }

  function instantiateWith(memory) {
    ppcWorkerModule({ wasmMemory: memory })
      .then((m) => {
        mod = m;
        const v = mod._ppc_worker_version();
        postMessage({ cmd: 'ready', version: v });
      })
      .catch((e) => {
        postMessage({ cmd: 'error', error: 'instantiate failed: ' + (e && e.message ? e.message : String(e)) });
      });
  }

  self.onmessage = (e) => {
    const data = e.data || {};
    switch (data.cmd) {
      case 'mem-init': {
        // The page hands us a SharedArrayBuffer-backed WebAssembly.Memory.
        // Phase 2c Step 2: this is currently created by the page just for
        // ppc-worker. Step 3 will share it with dolphin_worker too.
        if (!data.memory || !(data.memory instanceof WebAssembly.Memory)) {
          postMessage({ cmd: 'error', error: 'mem-init requires memory: WebAssembly.Memory' });
          return;
        }
        instantiateWith(data.memory);
        break;
      }
      case 'init': {
        if (!mod) { postMessage({ cmd: 'init-nack', reason: 'wasm not yet ready' }); return; }
        const ppcStateAddr = (data.ppcStateAddr | 0) >>> 0;
        const mem1Addr     = (data.mem1Addr     | 0) >>> 0;
        const mem1Size     = (data.mem1Size     | 0) >>> 0;
        const mailboxAddr  = (data.mailboxAddr  | 0) >>> 0;
        mod._ppc_worker_init(ppcStateAddr, mem1Addr, mem1Size, mailboxAddr);
        inited = true;
        postMessage({ cmd: 'init-ack' });
        break;
      }
      case 'dispatch': {
        if (!inited) { postMessage({ cmd: 'dispatch-nack', reason: 'not initialised' }); return; }
        const next = mod._ppc_worker_dispatch((data.pc | 0) >>> 0) >>> 0;
        postMessage({ cmd: 'dispatch-ack', next });
        break;
      }
      case 'shutdown': {
        if (mod) mod._ppc_worker_shutdown();
        postMessage({ cmd: 'shutdown-ack' });
        break;
      }
      default:
        postMessage({ cmd: 'error', error: 'unknown cmd: ' + data.cmd });
    }
  };
})();
