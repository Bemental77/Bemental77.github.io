// microbench_worker.js — owns the ppc-worker WASM module for the microbench.
// Topic: gamecube/docs/native-speed-gap-test/TASKS.md.
//
// Provides no-op env imports so the fixture block (emitted with
// emit_perf_stub=true) instantiates without dolphin_worker. The perf-stub
// flag replaces WIMPORT_* call sites with drop+const-0 but the module
// still DECLARES the imports — they must be supplied at instantiate time
// or WebAssembly.Instance() throws.

let Module = null;
let memoryReady = null;
let memoryResolve = null;

function log(msg) { postMessage({ type: 'log', payload: msg }); }

// Wait until the page sends the shared WebAssembly.Memory.
memoryReady = new Promise((resolve) => { memoryResolve = resolve; });

onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'mem-init') {
      memoryResolve(payload.memory);
      await initModule(payload.memory);
      const handle = Module._ppc_mb_init_fixture();
      postMessage({ type: 'init-done', payload: { handle, fixture_pc: 0x10000000, fixture_instrs: 16 } });
      return;
    }
    if (type === 'run') {
      if (!Module) throw new Error('module not initialized');
      const { layer, iters } = payload;
      const t0 = Module._ppc_mb_now_ms();
      let acc;
      switch (layer) {
        case 'L0': acc = Module._ppc_mb_run_l0_empty_emasm(iters >>> 0); break;
        case 'L1': acc = Module._ppc_mb_run_l1_dispatch_raw(iters >>> 0); break;
        case 'L2': acc = Module._ppc_mb_run_l2_direct(iters >>> 0); break;
        default: throw new Error('unknown layer: ' + layer);
      }
      const t1 = Module._ppc_mb_now_ms();
      postMessage({ id, type: 'run-done', payload: { ms: t1 - t0, acc: acc >>> 0 } });
      return;
    }
  } catch (err) {
    postMessage({ id, type: 'err', err: (err && err.message) ? err.message : String(err) });
  }
};

async function initModule(wasmMemory) {
  // Import the emcc factory from the ppc-worker build directory. MODULARIZE=1
  // makes ppc_worker_mb.js export a default async factory.
  importScripts('../ppc-worker/ppc_worker_mb.js');

  // No-op env imports — the fixture block's emit_perf_stub=true means call
  // sites are stubbed but the declarations remain in the wasm module.
  // Populate Module.bemental_imports.env BEFORE compile_raw fires.
  const env = {
    ppc_read8:       () => 0,
    ppc_read16:      () => 0,
    ppc_read32:      () => 0,
    ppc_write8:      () => {},
    ppc_write16:     () => {},
    ppc_write32:     () => {},
    ppc_check_exc:   () => 0,
    ppc_break_block: () => {},
    ppc_hle_check:   () => 0,
    ppc_hle_fire:    () => 0,
    ppc_interp:      () => 0,
  };

  Module = await ppcWorkerModule({
    wasmMemory,
    bemental_imports: { env },
    // The emcc-generated ppc_worker_mb.js fetches ppc_worker_mb.wasm
    // relative to its OWN location. Worker is at gamecube/microbench/
    // but the .wasm lives next to .js in gamecube/ppc-worker/.
    locateFile: (file) => '../ppc-worker/' + file,
  });

  // Allocate a small PowerPCState-shaped buffer (5 KB is enough per the
  // ppc_off layout in gekko_emit.h). The fixture only touches ctx[r3]
  // (offset 0x14 + 3*4 = 0x20) and ctx[LR] (SPR_BASE + LR_idx*4 = 0x340
  // + 8*4 = 0x360). malloc the whole 5 KB and pass that base to
  // ppc_worker_init so g_ppc_state_base is non-zero — required by
  // build_block's ctx_ptr_const parameter.
  const PPC_STATE_SIZE = 8192;
  const ppcStateAddr = Module._malloc(PPC_STATE_SIZE);
  Module.HEAPU8.fill(0, ppcStateAddr, ppcStateAddr + PPC_STATE_SIZE);

  // Other init args don't matter for the microbench (we never touch MEM1
  // or the mailbox); pass 0/0/0 so ppc_worker_init's stores don't trap.
  Module._ppc_worker_init(ppcStateAddr, 0, 0, 0);

  log('ppc-worker mb module ready; ppcStateAddr=0x' + ppcStateAddr.toString(16));
}
