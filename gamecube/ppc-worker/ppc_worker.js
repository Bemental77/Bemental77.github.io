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
      case 'sab-peek': {
        if (!mod) { postMessage({ cmd: 'sab-peek-nack', reason: 'wasm not yet ready' }); return; }
        const value = mod._ppc_worker_peek_u32((data.addr | 0) >>> 0) >>> 0;
        postMessage({ cmd: 'sab-peek-ack', addr: data.addr, value });
        break;
      }
      case 'mailbox-demo': {
        if (!inited) { postMessage({ cmd: 'mailbox-demo-nack', reason: 'not initialised' }); return; }
        // ppc-worker pokes its mailbox slot with a sentinel. The page
        // then DataView-reads the same SAB offset to confirm the write
        // is visible cross-worker.
        mod._ppc_worker_mailbox_post_demo((data.sentinel | 0) >>> 0);
        postMessage({ cmd: 'mailbox-demo-ack', sentinel: data.sentinel });
        break;
      }
      case 'mmio-read-test': {
        // Phase 2c.4d/4e: ppc-worker → mailbox → dolphin → return value.
        if (!inited) { postMessage({ cmd: 'mmio-read-test-nack', reason: 'not initialised' }); return; }
        const value = mod._ppc_worker_mmio_read32((data.addr | 0) >>> 0) >>> 0;
        postMessage({ cmd: 'mmio-read-test-ack', addr: data.addr, value });
        break;
      }
      case 'mmio-rw-suite': {
        // Phase 2c.4f-1: exercise read8/read16/write8/write16/write32
        // through the mailbox. dolphin handles each via dolphin_read*/
        // dolphin_write* into Memory.GetMMIOMapping(). This validates
        // the new arg1 slot and all six cmd handlers.
        if (!inited) { postMessage({ cmd: 'mmio-rw-suite-nack', reason: 'not initialised' }); return; }
        const PI_MASK = 0xCC003004;
        // Read current PI mask (32-bit).
        const mask32 = mod._ppc_worker_mmio_read32(PI_MASK) >>> 0;
        // Read first byte of mask (8-bit). Should be the LOW byte
        // (PI mask is little-endian on the wire from MMIO ops? Actually
        // PowerPC is big-endian — the high byte of the u32 is at the
        // lowest offset). dolphin_read8(addr) returns the byte at addr.
        const byte0 = mod._ppc_worker_mmio_read8(PI_MASK)  >>> 0;
        const half0 = mod._ppc_worker_mmio_read16(PI_MASK) >>> 0;
        // Write into a benign register slot — re-write the SAME mask
        // back to itself so we don't disturb dolphin state.
        mod._ppc_worker_mmio_write32(PI_MASK, mask32);
        const mask32b = mod._ppc_worker_mmio_read32(PI_MASK) >>> 0;
        postMessage({ cmd: 'mmio-rw-suite-ack',
          mask32, byte0, half0, mask32b });
        break;
      }
      case 'mailbox-call': {
        // Phase 2c.4c: synchronous request-reply. ppc-worker C++
        // publishes (mboxCmd, arg0) into the mailbox slot, Atomics.waits
        // for the consumer (page) to write reply + reply_ready.
        // BLOCKS this worker until the page responds.
        if (!inited) { postMessage({ cmd: 'mailbox-call-nack', reason: 'not initialised' }); return; }
        const reply = mod._ppc_worker_mailbox_call_sync(
          (data.mboxCmd | 0) >>> 0, (data.arg0 | 0) >>> 0) >>> 0;
        postMessage({ cmd: 'mailbox-call-ack', reply });
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
