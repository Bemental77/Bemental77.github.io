// gamecube/ppc-worker/ppc_worker.js
// JS-side dedicated PowerPC JIT worker. Phase 2a foundation: loads
// ppc_worker.wasm (which hosts bementalJIT) and waits for `init`,
// `dispatch`, and `shutdown` postMessages. Stubs only — Phase 2c will
// wire actual dispatch.
//
// Spawned by gamecube.html (or directly by dolphin_worker once the
// cutover lands). Lives parallel to dolphin_worker; communicates via
// SharedArrayBuffer + Atomics + postMessage.

(function () {
  let mod = null;
  let inited = false;

  // Dynamic import the emcc-generated bootstrap. The build outputs
  // ppc_worker.js as a MODULARIZE=1 factory exposing ppcWorkerModule().
  // We avoid the importScripts dance by using fetch + text/eval inside
  // the worker — reliable across browsers and easy to reason about.
  fetch('./ppc_worker_emcc.js')
    .then((r) => r.text())
    .then((js) => {
      // The emcc bundle defines `ppcWorkerModule` as a global factory.
      // Eval it into worker scope.
      // eslint-disable-next-line no-eval
      (0, eval)(js);
      // ppcWorkerModule is now defined; instantiate.
      // eslint-disable-next-line no-undef
      ppcWorkerModule().then((m) => {
        mod = m;
        const v = mod._ppc_worker_version();
        postMessage({ cmd: 'ready', version: v });
      });
    })
    .catch((e) => {
      postMessage({ cmd: 'error', error: 'load failed: ' + (e && e.message ? e.message : String(e)) });
    });

  self.onmessage = (e) => {
    const data = e.data || {};
    switch (data.cmd) {
      case 'init': {
        if (!mod) { postMessage({ cmd: 'init-nack', reason: 'wasm not yet ready' }); return; }
        // Phase 2a: SAB sharing wiring is deferred. Pass placeholder
        // zeros so init() runs through and we get the [ppc-worker] init log.
        const ppcStateAddr = data.ppcStateAddr | 0;
        const mem1Addr     = data.mem1Addr | 0;
        const mem1Size     = data.mem1Size >>> 0;
        const mailboxAddr  = data.mailboxAddr | 0;
        mod._ppc_worker_init(ppcStateAddr, mem1Addr, mem1Size, mailboxAddr);
        inited = true;
        postMessage({ cmd: 'init-ack' });
        break;
      }
      case 'dispatch': {
        if (!inited) { postMessage({ cmd: 'dispatch-nack', reason: 'not initialised' }); return; }
        const next = mod._ppc_worker_dispatch(data.pc >>> 0) >>> 0;
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
