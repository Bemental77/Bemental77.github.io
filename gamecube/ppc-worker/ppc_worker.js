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
        // 2f.6: auto-bootstrap mod.bemental_imports.env (host imports
        // for JIT-emitted blocks) and mod.bemental_regions (region
        // table). These were previously cascade-test-only steps; now
        // production paths (run-continuous via ?ppcperf=1) need them
        // too. Idempotent — overwrites any prior values.
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
        if (!mod.bemental_regions) mod.bemental_regions = {};
        postMessage({ cmd: 'init-ack' });
        break;
      }
      case 'update-mem': {
        // 2g: deferred MEM1 wiring. Page calls Module._dolphin_get_ram_addr
        // once dolphin's runtime is ready, posts here. ppc-worker's
        // self-compile path needs g_mem1_base/g_mem1_size set so it can
        // read guest instructions directly from SAB-mapped RAM.
        if (!mod) { postMessage({ cmd: 'update-mem-nack', reason: 'wasm not yet ready' }); return; }
        const newMem1Addr = (data.mem1Addr | 0) >>> 0;
        const newMem1Size = (data.mem1Size | 0) >>> 0;
        // Re-init keeps ppcStateAddr/mailboxAddr the same (we don't have a
        // separate setter for just mem1).
        const ppcStateAddr = 0x02400000;
        const mailboxAddr  = mailboxBase || 0x02000000;
        mod._ppc_worker_init(ppcStateAddr, newMem1Addr, newMem1Size, mailboxAddr);
        postMessage({ cmd: 'update-mem-ack', mem1Addr: newMem1Addr, mem1Size: newMem1Size });
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
        const compileOnMiss = !!data.compileOnMiss;
        let iters = 0;
        let exitReason = 'max-iters';
        let compileCalls = 0;
        let totalCompileBytes = 0;
        for (; iters < maxIters; ++iters) {
          let region = null, idx = -1;
          for (const k in regions) {
            const r = regions[k];
            if (r && r.pcMap && r.pcMap.has(pc)) { region = r; idx = r.pcMap.get(pc); break; }
          }
          if (!region) {
            if (!compileOnMiss) { exitReason = 'unmapped'; break; }
            // 4f-5 page-mediated CompileBlock (cmd 13). Page polls the
            // mailbox slot, synthesizes wasm bytes, writes them into
            // SAB scratch, and replies with (offset, size, region<<16|fn)
            // via reply + reply_extra1 + reply_extra2 fields. ppc-worker
            // copies bytes out of SAB and instantiates locally. Real
            // bementalJIT-driven delivery comes once the dolphin compile
            // path is wired (still pending — page synthesizes the test
            // stub for now).
            const bytesOffset = mod._ppc_worker_mailbox_call_sync(13, pc) >>> 0;
            const bytesSize   = mod._ppc_worker_peek_u32(mailboxBase + 24) >>> 0;
            const packed      = mod._ppc_worker_peek_u32(mailboxBase + 28) >>> 0;
            ++compileCalls;
            totalCompileBytes += bytesSize;
            if (bytesSize === 0) { exitReason = 'compile-empty'; break; }
            // 2f.0: reply_extra2 packs cycles + region + fn:
            //   bits 0-15:  fn idx (16-bit)
            //   bits 16-23: region idx (8-bit)
            //   bits 24-31: cycle count (8-bit, 0..255)
            // cycles = 0 means stub or pre-boot fallback (treat as 1 to
            // keep downcount progressing).
            const regionIdx   = (packed >>> 16) & 0xFF;
            const fnIdx       = packed & 0xFFFF;
            const blockCycles = ((packed >>> 24) & 0xFF) || 1;
            try {
              const bytes = new Uint8Array(sharedMemoryRef.buffer, bytesOffset, bytesSize).slice();
              const wmod = new WebAssembly.Module(bytes);
              const importObj = mod.bemental_imports
                ? { env: mod.bemental_imports.env } : {};
              const inst = new WebAssembly.Instance(wmod, importObj);
              if (!regions[regionIdx]) {
                regions[regionIdx] = { instance: inst, exports: inst.exports, pcMap: new Map(), cycleMap: new Map(), nFuncs: 0 };
              } else {
                regions[regionIdx].instance = inst;
                regions[regionIdx].exports = inst.exports;
                if (!regions[regionIdx].pcMap) regions[regionIdx].pcMap = new Map();
                if (!regions[regionIdx].cycleMap) regions[regionIdx].cycleMap = new Map();
              }
              regions[regionIdx].pcMap.set(pc >>> 0, fnIdx);
              regions[regionIdx].cycleMap.set(pc >>> 0, blockCycles);  // 2f.0
              regions[regionIdx].nFuncs = Math.max(regions[regionIdx].nFuncs || 0, fnIdx + 1);
              region = regions[regionIdx];
              idx = fnIdx;
            } catch (e) {
              exitReason = 'compile-instantiate: ' + (e && e.message ? e.message : String(e));
              break;
            }
          }
          // bementalJIT-emitted modules export the entrypoint as `run`
          // (see gekko_emit.cpp::4006). Test wasms (4f-4 hand-built,
          // 4f-5 page-stub) export per-block names like `block0`. Fall
          // back from one to the other so both shapes dispatch.
          const fn = region.exports['block' + idx] || region.exports.run;
          if (typeof fn !== 'function') { exitReason = 'no-block-export'; break; }
          try {
            pc = fn() >>> 0;
          } catch (e) {
            exitReason = 'block-trap: ' + (e && e.message ? e.message : String(e));
            break;
          }
        }
        postMessage({ cmd: 'run-ack', iters, lastPc: pc, exitReason, compileCalls, totalCompileBytes });
        break;
      }
      case 'run-continuous': {
        // 2f.1: continuous dispatch loop. Drives ppc-worker as the
        // PowerPC dispatch source — reads live PC from SAB ppc_state
        // (post-2e.4), dispatches block, decrements downcount, repeats
        // until a natural exit (downcount<=0, exception, idle-skip,
        // stop-flag). Replaces the maxIters-bounded 'run' handler for
        // production use; the bounded 'run' stays for verification.
        //
        // Exit reasons:
        //   'downcount-exhausted' — dolphin needs to advance scheduler
        //   'exception-pending'   — Exceptions != 0; dolphin handles vector
        //   'idle-skip'           — same pc > 100 dispatches; dolphin's
        //                            CoreTiming::Idle() should fast-forward
        //   'unmapped'            — block lookup miss + compileOnMiss=false
        //   'stop-flag'           — external (page or dolphin) set the
        //                            yield flag at SAB[0x02500000]
        //   'safety-cap'          — hit the hard cap (sanity bound)
        //   'block-trap: ...'     — wasm trap inside dispatched block
        if (!mod || !mod.bemental_regions) { postMessage({ cmd: 'run-continuous-nack', reason: 'no regions' }); return; }
        if (!sharedMemoryRef) { postMessage({ cmd: 'run-continuous-nack', reason: 'no shared memory' }); return; }
        const regions = mod.bemental_regions;
        const compileOnMiss = !!data.compileOnMiss;
        const safetyCap = ((data.safetyCap | 0) >>> 0) || 100000;
        // Phase 3a.4 — feature flag for the merged-region dispatch path.
        // When `mergedRegion: true`, dispatch goes through the C-side
        // ppc_worker_region_dispatch_pc which uses BlockCache::region_dispatch
        // (single merged WASM module per region; V8 cross-block inlining
        // possible since blocks are in the same instance). Falls through
        // to compile_and_accumulate + relink_region_if_due on miss.
        // When false: legacy 2g per-block-instance path (unchanged).
        const mergedRegion = !!data.mergedRegion;
        // Phase 3a.5 — relink cadence. Tighter than research's 256-iter
        // suggestion: at 110 blocks/sec baseline, 256 iters could be
        // multiple seconds, leaving the merged path stuck waiting for
        // first module. Every 32 iters means the first 64 misses (ie the
        // first compile-storm) trigger relink within ~2 ms even at the
        // legacy throughput rate. Cost: 32× more region_should_relink
        // calls — each is ≤9 hashmap-size + time-delta checks (cheap).
        const relinkCheckMask = 0x1f;  // every 32 iters
        // 2f.6: perf-measurement mode bypasses downcount/exception/idle
        // termination so we can clock raw dispatch throughput. Still
        // honors stop-flag and safetyCap.
        const ignoreDowncount = !!data.ignoreDowncount;
        const wallTimeMs = (data.wallTimeMs | 0) || 0;

        // Phase 3a-fix (Option A): swap env.ppc_* imports to no-op stubs
        // when in perf-measurement mode. Background: every env.ppc_*
        // import calls _ppc_worker_mailbox_call_sync which Atomics.waits
        // for dolphin to drain the mailbox. dolphin's pthread is busy
        // in _run_iter_batch(100K) during boot and NEVER drains, so any
        // dispatched block that hits an env.ppc_* import hangs forever
        // (verified: iter=1 block at 0x80003254 hung in the 2g test).
        // Stubs return 0 (or void) immediately — loop progresses. The
        // dispatched code's side effects are wrong (memory reads return
        // 0) but that was already true under ignoreDowncount: ppc-worker
        // runs concurrent with dolphin which owns canonical state.
        // Throughput measurement IS the only goal here.
        //
        // Must mutate env BEFORE any new WebAssembly.Instance is created
        // in the loop — instances capture import refs at instantiation.
        // We swap on the SAME object (mod.bemental_imports.env) so any
        // future instances pick up the stubs.
        //
        // No restore: perf mode is one-shot per session. After the loop
        // exits the stubs stay, but no other dispatch path runs.
        if (ignoreDowncount && mod.bemental_imports && mod.bemental_imports.env
            && !mod.bemental_imports.env._stubbed_for_perf) {
          const env = mod.bemental_imports.env;
          env.ppc_read8       = () => 0;
          env.ppc_read16      = () => 0;
          env.ppc_read32      = () => 0;
          env.ppc_write8      = () => {};
          env.ppc_write16     = () => {};
          env.ppc_write32     = () => {};
          env.ppc_hle_check   = () => 0;
          env.ppc_interp      = () => {};
          env.ppc_check_exc   = () => 0;
          env.ppc_break_block = () => {};
          env.ppc_read_tb     = () => 0;
          env._stubbed_for_perf = true;
          postMessage({ cmd: 'print',
            txt: '[ppc-worker] env.ppc_* stubbed for perf-measurement mode '
               + '(returns 0; correctness sacrificed for throughput)' });
        }
        const wallStart = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        // PowerPCState SAB offsets per ppc_worker_main.cpp layout comment.
        const PPC_STATE_BASE   = 0x02400000;
        const OFFSET_PC        = 0x000;
        const OFFSET_MSR       = 0x2E0;
        const OFFSET_EXC       = 0x2EC;
        const OFFSET_DOWNCOUNT = 0x2F0;
        // 2f.2 reserves SAB[0x02500000] for the dolphin yield flag
        // (page sets → dolphin returns from Run()). ppc-worker uses
        // a separate stop flag at +4 so the two signals don't conflict.
        const STOP_FLAG_ADDR   = 0x02500004;
        const u32 = new Uint32Array(sharedMemoryRef.buffer);
        const i32 = new Int32Array(sharedMemoryRef.buffer);  // downcount is signed
        // Initial PC: caller-supplied wins, else read from SAB ppc_state.
        let pc;
        if (typeof data.startPc === 'number') {
          pc = (data.startPc | 0) >>> 0;
          u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] = pc;
        } else {
          pc = u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] >>> 0;
        }
        // 2f.6 diag: log what ppc-worker sees at the ppc_state offsets.
        // If page sees 0xcafe1234 here but dolphin writes real PCs in
        // the same address, the views are inconsistent.
        const _diag_pc  = u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] >>> 0;
        const _diag_msr = u32[(PPC_STATE_BASE + OFFSET_MSR) >> 2] >>> 0;
        const _diag_dc  = i32[(PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2];
        const _diag_buf = sharedMemoryRef ? sharedMemoryRef.buffer.byteLength : 0;
        postMessage({ cmd: 'print',
          txt: '[ppc-worker-diag] SAB[0x02400000+0]=0x' + _diag_pc.toString(16)
             + ' MSR=0x' + _diag_msr.toString(16)
             + ' downcount=' + _diag_dc
             + ' bufBytes=' + _diag_buf });
        let iters = 0;
        let compileCalls = 0;
        let totalCompileBytes = 0;
        let exitReason = 'safety-cap';
        let lastPc = 0xFFFFFFFF;
        let samePcCount = 0;
        for (; iters < safetyCap; ++iters) {
          // External stop flag (page or dolphin requesting yield).
          if (Atomics.load(i32, STOP_FLAG_ADDR >> 2) !== 0) {
            exitReason = 'stop-flag'; break;
          }
          // Exception pending? Let dolphin vector the handler.
          if (!ignoreDowncount) {
            const exc = u32[(PPC_STATE_BASE + OFFSET_EXC) >> 2] >>> 0;
            if (exc !== 0) {
              const msr = u32[(PPC_STATE_BASE + OFFSET_MSR) >> 2] >>> 0;
              const EXC_EXTERNAL_INT = 0x00000004;
              const MSR_EE = 0x8000;
              const externalOnly = (exc & ~EXC_EXTERNAL_INT) === 0;
              if (!externalOnly || (msr & MSR_EE) !== 0) {
                exitReason = 'exception-pending'; break;
              }
            }
            const downcount = i32[(PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2];
            if (downcount <= 0) { exitReason = 'downcount-exhausted'; break; }
          }
          // Wall-time cap (perf-measurement mode).
          if (wallTimeMs > 0 && (iters & 0xfff) === 0) {
            const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
            if ((now - wallStart) >= wallTimeMs) { exitReason = 'wall-time-cap'; break; }
          }
          // Phase 3a.4 fast-path: merged-region dispatch via C side.
          // Phase 3a.5: also a startup force-relink. On the very first
          // miss-storm (no module yet for the entry region) the natural
          // 64-block threshold means dispatch keeps missing until 64
          // accumulates. Forcing relink on iter==0 + after ANY accumulate
          // shrinks the warm-up window from seconds to milliseconds.
          // ppc_worker_region_dispatch_pc returns next-pc on hit, or
          // 0xFFFFFFFF on miss. C-side BlockCache::region_dispatch
          // does the pcMap lookup + regionFn() call inside one
          // EM_ASM_INT — far less per-iter overhead than the legacy
          // JS-side scan + per-block instance.exports lookup.
          if (mergedRegion) {
            const next = mod._ppc_worker_region_dispatch_pc(pc) >>> 0;
            if (next !== 0xFFFFFFFF) {
              // Hit. Update SAB pc + fall through to downcount/loop.
              if (!ignoreDowncount) {
                Atomics.sub(i32, (PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2, 1);
              }
              u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] = next;
              // Same-PC idle-skip detector applies to merged path too.
              if (next === lastPc) {
                if (++samePcCount > 100) { exitReason = 'idle-skip'; break; }
              } else { samePcCount = 0; lastPc = next; }
              pc = next;
              continue;
            }
            // Miss → fall through to compile_and_accumulate.
            const bytesSize = mod._ppc_worker_compile_and_accumulate(pc) >>> 0;
            if (bytesSize > 0) {
              ++compileCalls;
              totalCompileBytes += bytesSize;
            }
            // Phase 3a.5 force-relink-on-warmup: the natural threshold
            // (≥64 blocks) means the very first miss-storm sits compiling
            // for 64 iters before the first module materializes. Force
            // relink for the first 16 iterations to shrink that to ~16
            // misses; afterwards rely on the natural threshold.
            if (iters < 16 && bytesSize > 0) {
              mod._ppc_worker_force_relink_all(0);
            } else if ((iters & relinkCheckMask) === 0) {
              mod._ppc_worker_relink_region_if_due(0);
            }
            // pc unchanged; next iter retries dispatch (on the same pc
            // if relink happened it'll hit, else continues compiling).
            continue;
          }
          // Legacy 2g per-block-instance path (unchanged).
          let region = null, idx = -1, blockCycles = 1;
          for (const k in regions) {
            const r = regions[k];
            if (r && r.pcMap && r.pcMap.has(pc)) {
              region = r; idx = r.pcMap.get(pc);
              if (r.cycleMap && r.cycleMap.has(pc)) blockCycles = r.cycleMap.get(pc) || 1;
              break;
            }
          }
          if (!region) {
            if (!compileOnMiss) { exitReason = 'unmapped'; break; }
            // 2g: ppc-worker self-compile. Reads guest instructions from
            // SAB-mapped MEM1 directly, calls bemental::powerpc::build_block
            // in-process, returns module bytes via static buffer. Replaces
            // the cmd-13 mailbox round-trip to dolphin (which hangs once
            // dolphin's pthread is in steady-state retro_run loop).
            const bytesSize = mod._ppc_worker_compile_block(pc) >>> 0;
            const bytesOffset = mod._ppc_worker_compile_buf_addr() >>> 0;
            const cycles = mod._ppc_worker_compile_cycles() >>> 0 || 1;
            ++compileCalls;
            totalCompileBytes += bytesSize;
            if (bytesSize === 0) { exitReason = 'compile-empty'; break; }
            // Self-compile uses a single growing region; assign sequential
            // function indices into region 0.
            const regionIdx = 0;
            try {
              if (!regions[regionIdx]) {
                regions[regionIdx] = { pcMap: new Map(), cycleMap: new Map(), instances: [] };
              }
              const fnIdx = regions[regionIdx].instances.length;
              const bytes = new Uint8Array(sharedMemoryRef.buffer, bytesOffset, bytesSize).slice();
              const wmod = new WebAssembly.Module(bytes);
              const importObj = mod.bemental_imports
                ? { env: mod.bemental_imports.env } : {};
              const inst = new WebAssembly.Instance(wmod, importObj);
              regions[regionIdx].instances.push(inst);
              regions[regionIdx].pcMap.set(pc >>> 0, fnIdx);
              regions[regionIdx].cycleMap.set(pc >>> 0, cycles);
              region = regions[regionIdx];
              idx = fnIdx;
              blockCycles = cycles;
            } catch (e) {
              exitReason = 'compile-instantiate: ' + (e && e.message ? e.message : String(e));
              break;
            }
          }
          // Same-PC idle-skip detector (port of JitWasm.cpp:3686+).
          // Increments when the same pc is dispatched repeatedly, which
          // happens for busy-wait loops (e.g., bne -8 polling SAB poll
          // patterns from sab_polling_loop_skip). After 100 same-pc
          // dispatches, exit so dolphin's CoreTiming::Idle() can
          // fast-forward to the next event.
          if (pc === lastPc) {
            ++samePcCount;
            if (samePcCount > 100) {
              exitReason = 'idle-skip'; break;
            }
          } else {
            samePcCount = 0;
            lastPc = pc;
          }
          // Dispatch. 2g self-compile uses one Instance per block in
          // region.instances[]; legacy mailbox path stores a single
          // multi-block instance in region.exports.
          let fn;
          if (region.instances) {
            const inst = region.instances[idx];
            fn = inst && (inst.exports['block' + idx] || inst.exports.block0 || inst.exports.run);
          } else {
            fn = region.exports['block' + idx] || region.exports.run;
          }
          if (typeof fn !== 'function') { exitReason = 'no-block-export'; break; }
          let nextPc;
          try {
            nextPc = fn() >>> 0;
          } catch (e) {
            exitReason = 'block-trap: ' + (e && e.message ? e.message : String(e));
            break;
          }
          // Decrement downcount per dispatch (post-2f.0 cycles plumbing).
          // Use Atomics.sub to keep this race-free with dolphin's parallel
          // Run() until 2f.2 wires the yield handshake. In perf mode we
          // skip this (downcount accounting is dolphin's job there).
          if (!ignoreDowncount) {
            Atomics.sub(i32, (PPC_STATE_BASE + OFFSET_DOWNCOUNT) >> 2, blockCycles);
          }
          // Update SAB pc to the new value (block return is canonical
          // per Q2 finding).
          u32[(PPC_STATE_BASE + OFFSET_PC) >> 2] = nextPc;
          pc = nextPc;
        }
        postMessage({
          cmd: 'run-continuous-ack',
          iters, lastPc: pc, exitReason, compileCalls, totalCompileBytes,
          samePcCount,
        });
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
