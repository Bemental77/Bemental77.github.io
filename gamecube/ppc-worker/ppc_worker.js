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
  let sharedMemoryRef = null;  // the WebAssembly.Memory we received via mem-init
  let mailboxBase = 0;         // remembered from 'init' so the run loop can
                               // peek reply_extra1/2 after a CompileBlock

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
        // Phase 2c Step 3: same memory is shared with dolphin_worker via
        // Module.wasmMemory page-side injection.
        if (!data.memory || !(data.memory instanceof WebAssembly.Memory)) {
          postMessage({ cmd: 'error', error: 'mem-init requires memory: WebAssembly.Memory' });
          return;
        }
        sharedMemoryRef = data.memory;
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
        mailboxBase = mailboxAddr;
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
      case 'init-bemental-regions': {
        // Phase 2c.4f-3: stand up the JS-side region storage in
        // ppc-worker. After this, region-instantiate accepts wasm
        // bytes and stores the resulting Instance in mod.bemental_regions[r],
        // analogous to dolphin's block_cache.cpp::region_relink path.
        if (!mod) { postMessage({ cmd: 'init-bemental-regions-nack', reason: 'wasm not yet ready' }); return; }
        if (!mod.bemental_regions) mod.bemental_regions = {};
        const had_env = (mod.bemental_imports && mod.bemental_imports.env);
        postMessage({ cmd: 'init-bemental-regions-ack', had_env: !!had_env });
        break;
      }
      case 'region-instantiate': {
        // Receives:
        //   regionIdx: 0..7
        //   bytes: ArrayBuffer of the wasm module
        //   imports: 'env' (use mod.bemental_imports.env) or 'none' (no imports)
        //   pcKeys: optional Uint32Array of PCs for pcMap
        // Stores in mod.bemental_regions[regionIdx].
        if (!mod) { postMessage({ cmd: 'region-instantiate-nack', reason: 'wasm not yet ready' }); return; }
        if (!mod.bemental_regions) mod.bemental_regions = {};
        try {
          const bytes = new Uint8Array(data.bytes);
          const wmod = new WebAssembly.Module(bytes);
          const importObj = (data.imports === 'env' && mod.bemental_imports)
            ? { env: mod.bemental_imports.env }
            : {};
          const inst = new WebAssembly.Instance(wmod, importObj);
          const region = { instance: inst, exports: inst.exports };
          if (data.pcKeys) {
            const pcMap = new Map();
            const arr = new Uint32Array(data.pcKeys);
            for (let i = 0; i < arr.length; ++i) pcMap.set(arr[i] >>> 0, i);
            region.pcMap = pcMap;
            region.nFuncs = arr.length;
          }
          mod.bemental_regions[data.regionIdx | 0] = region;
          const exportNames = Object.keys(inst.exports);
          postMessage({ cmd: 'region-instantiate-ack', regionIdx: data.regionIdx, exportNames });
        } catch (e) {
          postMessage({ cmd: 'region-instantiate-nack', reason: 'instantiate failed: ' + (e && e.message ? e.message : String(e)) });
        }
        break;
      }
      case 'region-call-export': {
        // Calls a named export from a stored region. For test-mode
        // bytes the export takes no args and returns i32; we just
        // return the value.
        if (!mod || !mod.bemental_regions) { postMessage({ cmd: 'region-call-export-nack', reason: 'no regions' }); return; }
        const region = mod.bemental_regions[data.regionIdx | 0];
        if (!region || !region.exports[data.exportName]) {
          postMessage({ cmd: 'region-call-export-nack', reason: 'no such export: ' + data.exportName });
          return;
        }
        try {
          const value = region.exports[data.exportName]() >>> 0;
          postMessage({ cmd: 'region-call-export-ack', regionIdx: data.regionIdx, exportName: data.exportName, value });
        } catch (e) {
          postMessage({ cmd: 'region-call-export-nack', reason: 'call failed: ' + (e && e.message ? e.message : String(e)) });
        }
        break;
      }
      case 'env-call-test': {
        // Phase 2c.4f-2 verify: invoke a binding from mod.bemental_imports.env
        // by NAME. If cmd 8/10/12 etc. handlers in dolphin are wired, they
        // return real values; if not, we get 0 and a spinning Atomics.wait.
        if (!inited || !mod.bemental_imports) { postMessage({ cmd: 'env-call-test-nack', reason: 'env not ready' }); return; }
        const env = mod.bemental_imports.env;
        const fn = env[data.name];
        if (typeof fn !== 'function') { postMessage({ cmd: 'env-call-test-nack', reason: 'no such fn: ' + data.name }); return; }
        const reply = fn((data.arg0 | 0) >>> 0) >>> 0;
        postMessage({ cmd: 'env-call-test-ack', name: data.name, arg0: data.arg0, reply });
        break;
      }
      case 'setup-bemental-env': {
        // Phase 2c.4f-2: build the env import object that JIT-emitted
        // blocks will resolve against when instantiated in ppc-worker
        // (Phase 2c.4f-3). Each binding mailboxes its request via
        // ppc_worker_mailbox_call_sync — dolphin executes the
        // corresponding dolphin_* function in its inner-iter poll.
        // Cmd codes match gamecube/ppc-worker/sab_layout.h::MailboxCmd.
        if (!inited) { postMessage({ cmd: 'setup-bemental-env-nack', reason: 'not initialised' }); return; }
        if (!mod.bemental_imports) mod.bemental_imports = { env: {} };
        const env = mod.bemental_imports.env;
        const call1 = (cmd, a) => mod._ppc_worker_mailbox_call_sync(cmd, a >>> 0) >>> 0;
        const call2 = (cmd, a, b) => { mod._ppc_worker_mailbox_call_sync2(cmd, a >>> 0, b >>> 0); };
        env.memory          = sharedMemoryRef;
        env.ppc_read8       = (addr) => call1(2, addr);
        env.ppc_read16      = (addr) => call1(3, addr);
        env.ppc_read32      = (addr) => call1(4, addr);
        env.ppc_write8      = (addr, val) => call2(5, addr, val);
        env.ppc_write16     = (addr, val) => call2(6, addr, val);
        env.ppc_write32     = (addr, val) => call2(7, addr, val);
        env.ppc_hle_check   = (pc) => call1(8, pc);
        env.ppc_interp      = (inst, pc) => call2(9, inst, pc);
        env.ppc_check_exc   = (pc) => call1(10, pc);
        env.ppc_break_block = (pc, x) => call2(11, pc, x);
        env.ppc_read_tb     = (which) => call1(12, which);
        const keys = Object.keys(env).sort();
        postMessage({ cmd: 'setup-bemental-env-ack', keys, count: keys.length });
        break;
      }
      case 'mmio-rw-suite': {
        // Phase 2c.4f-1: exercise read8/read16/write8/write16/write32
        // through the mailbox. dolphin handles each via dolphin_read*/
        // dolphin_write* into Memory.GetMMIOMapping(). This validates
        // the new arg1 slot and all six cmd handlers.
        if (!inited) { postMessage({ cmd: 'mmio-rw-suite-nack', reason: 'not initialised' }); return; }
        postMessage({ cmd: 'rw-suite-debug', stage: 'entered' });
        const PI_MASK = 0xCC003004;
        // Read current PI mask (32-bit).
        const mask32 = mod._ppc_worker_mmio_read32(PI_MASK) >>> 0;
        postMessage({ cmd: 'rw-suite-debug', stage: 'after-read32', value: mask32 });
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
      case 'run': {
        // Phase 2c.4f-4: replicate JitWasm::Run()'s inner-iter loop.
        // For each iteration: look pc up in some region's pcMap, call
        // the corresponding block export (named "block<idx>"), use
        // its return value as the next pc, repeat. Region lookup
        // iterates the small (≤8) region table — bementalJIT's real
        // bemental::classify() is constant-time on pc bits; deferred
        // until the multi-region storage carries a classify cache.
        //
        // Exit reasons (string):
        //   'unmapped'         — pc not in any region's pcMap (next
        //                         step in 4f-5 will mailbox a
        //                         CompileBlock to dolphin).
        //   'no-block-export'  — region.exports['block<idx>'] missing.
        //   'block-trap: ...'  — wasm trap inside dispatched block.
        //   'max-iters'        — iter budget exhausted (no exit cond).
        if (!mod || !mod.bemental_regions) { postMessage({ cmd: 'run-nack', reason: 'no regions' }); return; }
        let pc = (data.startPc | 0) >>> 0;
        const maxIters = ((data.maxIters | 0) >>> 0) || 100;
        const regions = mod.bemental_regions;
        let iters = 0;
        let exitReason = 'max-iters';
        for (; iters < maxIters; ++iters) {
          let region = null, idx = -1;
          for (const k in regions) {
            const r = regions[k];
            if (r && r.pcMap && r.pcMap.has(pc)) { region = r; idx = r.pcMap.get(pc); break; }
          }
          if (!region) { exitReason = 'unmapped'; break; }
          const fn = region.exports['block' + idx];
          if (typeof fn !== 'function') { exitReason = 'no-block-export'; break; }
          try {
            pc = fn() >>> 0;
          } catch (e) {
            exitReason = 'block-trap: ' + (e && e.message ? e.message : String(e));
            break;
          }
        }
        postMessage({ cmd: 'run-ack', iters, lastPc: pc, exitReason });
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
